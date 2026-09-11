import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityMappingStore, PersistedTransportIdentity } from "@umiro/core/identity";
import { chunkDiscordText, DiscordDeliveryWorker, DiscordIdentityResolver, toInputEvent } from "../src/index.js";

class MemoryMappings implements IdentityMappingStore {
  readonly rows = new Map<string, PersistedTransportIdentity>();
  async find(transport: string, externalId: string) { return this.rows.get(`${transport}:${externalId}`); }
  async findOrCreate(identity: PersistedTransportIdentity) {
    const key = `${identity.transport}:${identity.externalId}`;
    const existing = this.rows.get(key);
    if (existing) return existing;
    this.rows.set(key, identity);
    return identity;
  }
}

const authority = { capabilities: [], visibility: { kind: "all" as const }, instructionAuthority: "full" as const };

test("maps Discord messages and preserves stable principals", async () => {
  const store = new MemoryMappings();
  let sequence = 0;
  const resolver = new DiscordIdentityResolver(store, { ownerDiscordId: "1", ownerAuthority: authority, memberAuthority: authority, createPrincipalId: () => `member-${++sequence}` });
  const first = await resolver.resolve({ transport: "discord", externalId: "2", principalId: null });
  const second = await resolver.resolve({ transport: "discord", externalId: "2", principalId: null });
  assert.equal(first.principal.id, "member-1");
  assert.equal(second.principal.id, "member-1");
  assert.deepEqual((await resolver.resolve({ transport: "discord", externalId: "1", principalId: null })).principal.roles, ["owner"]);
  const event = toInputEvent({ messageId: "m", channelId: "thread", guildId: "g", threadId: "thread", threadParentId: "forum", threadParentName: "Travel", threadParentKind: "forum", authorId: "2", content: "hi", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(event.conversation.kind, "thread");
  assert.equal(event.content[0]?.type, "text");
  assert.deepEqual(event.metadata, { messageId: "m", channelId: "thread", guildId: "g", threadId: "thread", threadParentId: "forum", threadParentName: "Travel", threadParentKind: "forum" });
});

test("delivers pending Discord output and records confirmation", async () => {
  const marked: string[] = [];
  const sent: string[] = [];
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [{ id: "d", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text: "hello" }, state: "pending", createdAt: "now" }]; },
    async markDeliveryDelivered(id) { marked.push(id); },
    async markDeliveryFailed() {},
  }, { async sendText(channelId, text) { sent.push(`${channelId}:${text}`); return { messageId: "m" }; } });
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.deepEqual(sent, ["c:hello"]);
  assert.deepEqual(marked, ["d"]);
});

test("chunks long Discord output and records every delivered message", async () => {
  const sent: string[] = [];
  let evidence: Record<string, unknown> | undefined;
  const text = `前言\n\`\`\`ts\n${"const value = 1;\n".repeat(160)}\`\`\`\n結尾`;
  const chunks = chunkDiscordText(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 2_000));
  assert.ok(chunks.every(chunk => (chunk.match(/```/g)?.length ?? 0) % 2 === 0));
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [{ id: "long", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text }, state: "pending", createdAt: "now" }]; },
    async markDeliveryDelivered(_id, _at, value) { evidence = value; },
    async markDeliveryFailed() {},
  }, { async sendText(_channelId, chunk) { sent.push(chunk); return { messageId: `m${sent.length}` }; } });
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.deepEqual(sent, chunks);
  assert.deepEqual(evidence, { transport: "discord", messageId: "m1", messageIds: chunks.map((_chunk, index) => `m${index + 1}`), channelId: "c" });
});

test("marks an explicit no-reply outcome delivered without sending text", async () => {
  let evidence: Record<string, unknown> | undefined;
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [{ id: "silent", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text: "NO_REPLY" }, state: "pending", createdAt: "now" }]; },
    async markDeliveryDelivered(_id, _at, value) { evidence = value; },
    async markDeliveryFailed() {},
  }, { async sendText() { throw new Error("no-reply must not send a message"); } });
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.deepEqual(evidence, { transport: "discord", channelId: "c", skipped: "no_reply" });
});

test("delivers durable artifacts before marking the intent delivered", async () => {
  const events: string[] = [];
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [{ id: "d", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text: "", artifactIds: ["a"] }, state: "pending" as const, createdAt: "now" }]; },
    async markDeliveryDelivered(id) { events.push(`marked:${id}`); },
    async markDeliveryFailed() {},
  }, {
    async sendText() { throw new Error("text path must not run"); },
    async sendFiles(channelId, files) { events.push(`files:${channelId}:${files[0]?.name}`); return { messageId: "m" }; },
  }, () => "later", {
    async getArtifact() { return { id: "a", ownerPrincipalId: "owner", visibility: "shared", mediaType: "text/plain", filename: "report.txt", size: 1, sha256: "a".repeat(64), location: "/safe/report", state: "stored", createdAt: "now", updatedAt: "now" }; },
  });
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.deepEqual(events, ["files:c:report.txt", "marked:d"]);
});

test("persists delivery failure and retries only after durable backoff", async () => {
  const failures: string[] = []; let attempts = 0;
  const intent = { id: "d", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text: "hello" }, state: "pending" as const, attempts: 0, createdAt: "now" };
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [intent]; },
    async markDeliveryDelivered() {},
    async markDeliveryFailed(_id, error, next) { failures.push(`${error}:${next}`); },
  }, { async sendText() { attempts++; throw new Error("rate limited"); } }, () => "2026-09-09T00:00:00.000Z");
  assert.deepEqual(await worker.drain(), { delivered: 0, skipped: 1 });
  assert.equal(attempts, 1);
  assert.deepEqual(failures, ["rate limited:2026-09-09T00:00:01.000Z"]);
});
