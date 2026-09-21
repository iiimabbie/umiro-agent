import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityMappingStore, PersistedTransportIdentity } from "@umiro/core/identity";
import { ApplicationEmojiCatalog, chunkDiscordText, DiscordDeliveryWorker, DiscordIdentityResolver, normalizeDiscordMentions, toInputEvent } from "../src/index.js";

class MemoryMappings implements IdentityMappingStore {
  readonly rows = new Map<string, PersistedTransportIdentity>();
  async find(transport: string, externalId: string) { return this.rows.get(`${transport}:${externalId}`); }
  async findOrCreate(identity: PersistedTransportIdentity) {
    const key = `${identity.transport}:${identity.externalId}`;
    const existing = this.rows.get(key);
    if (existing) {
      const updated = { ...existing, ...(identity.displayName ? { displayName: identity.displayName } : {}) };
      this.rows.set(key, updated);
      return updated;
    }
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
  resolver.setOwnerDiscordId("3");
  assert.deepEqual((await resolver.resolve({ transport: "discord", externalId: "3", principalId: null })).principal.roles, ["owner"]);
  const named = await resolver.resolve({ transport: "discord", externalId: "2", principalId: null, displayName: "小明" });
  assert.equal(named.principal.displayName, "小明");
  const event = toInputEvent({ messageId: "m", channelId: "thread", guildId: "g", threadId: "thread", threadParentId: "forum", threadParentName: "Travel", threadParentKind: "forum", authorId: "2", authorName: "小明", content: "hi", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(event.conversation.kind, "thread");
  assert.equal(event.content[0]?.type, "text");
  assert.equal(event.identity.displayName, "小明");
  assert.deepEqual(event.metadata, { messageId: "m", channelId: "thread", guildId: "g", threadId: "thread", threadParentId: "forum", threadParentName: "Travel", threadParentKind: "forum" });
  const replied = toInputEvent({ messageId: "m2", channelId: "thread", guildId: "g", authorId: "2", content: "你看這張", createdAt: "2026-01-01T00:01:00Z", replyToMessageId: "m1", replyAuthorId: "3", replyToContent: "圖片", replyToAttachments: [{ id: "a1", url: "https://cdn.discordapp.com/a", filename: "photo.png", size: 3, mediaType: "image/png" }] });
  assert.equal(replied.metadata?.replyToAttachmentCount, 1);
});

test("normalizes known Discord user mentions while retaining stable IDs", () => {
  assert.equal(normalizeDiscordMentions("嗨 <@123456789012345678> 和 <@!223456789012345678>", new Map([["123456789012345678", "小明"], ["223456789012345678", "小美"]])), "嗨 <@123456789012345678>(小明) 和 <@223456789012345678>(小美)");
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

test("marks a confirmed duplicate delivered without sending it again", async () => {
  let evidence: Record<string, unknown> | undefined;
  let sends = 0;
  const intent = { id: "duplicate", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text: "hello" }, state: "pending" as const, createdAt: "now" };
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [intent]; },
    async markDeliveryDelivered(_id, _at, value) { evidence = value; },
    async markDeliveryFailed() {},
  }, { async sendText() { sends++; return { messageId: "unexpected" }; } }, () => "later", undefined, async () => ({ transport: "discord", channelId: "c", messageId: "existing", skipped: "duplicate_tool_delivery" }));
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.equal(sends, 0);
  assert.deepEqual(evidence, { transport: "discord", channelId: "c", messageId: "existing", skipped: "duplicate_tool_delivery" });
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

test("prepares Application Emoji markup before enforcing Discord chunk limits", async () => {
  const catalog = new ApplicationEmojiCatalog();
  catalog.replace([{ name: "party", id: "123456789012345678", animated: false }]);
  const source = ":party:".repeat(220);
  const expected = catalog.resolveText(source);
  const sent: string[] = [];
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [{ id: "emoji", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text: source }, state: "pending" as const, createdAt: "now" }]; },
    async markDeliveryDelivered() {},
    async markDeliveryFailed() {},
  }, { prepareText: text => catalog.resolveText(text), async sendText(_channelId, text) { sent.push(text); return { messageId: `m${sent.length}` }; } });
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.ok(sent.length > 1);
  assert.ok(sent.every(text => text.length <= 2_000));
  assert.equal(sent.join(""), expected);
});

test("marks an empty text outcome delivered without sending text", async () => {
  let evidence: Record<string, unknown> | undefined;
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [{ id: "silent", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text: "" }, state: "pending", createdAt: "now" }]; },
    async markDeliveryDelivered(_id, _at, value) { evidence = value; },
    async markDeliveryFailed() {},
  }, { async sendText() { throw new Error("empty text must not send a message"); } });
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.deepEqual(evidence, { transport: "discord", channelId: "c", skipped: "empty_text" });
});

test("delivers durable artifacts before marking the intent delivered", async () => {
  const events: string[] = [];
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [{ id: "d", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text: "here is the report", artifactIds: ["a"] }, state: "pending" as const, createdAt: "now" }]; },
    async markDeliveryDelivered(id) { events.push(`marked:${id}`); },
    async markDeliveryFailed() {},
  }, {
    async sendText() { throw new Error("text path must not run"); },
    async sendFiles(channelId, files, text) { events.push(`files:${channelId}:${files[0]?.name}:${text}`); return { messageId: "m" }; },
  }, () => "later", {
    async getArtifact() { return { id: "a", ownerPrincipalId: "owner", visibility: "shared", mediaType: "text/plain", filename: "report.txt", size: 1, sha256: "a".repeat(64), location: "/safe/report", state: "stored", createdAt: "now", updatedAt: "now" }; },
  });
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.deepEqual(events, ["files:c:report.txt:here is the report", "marked:d"]);
});

test("delivers overflow text before attaching files to the final chunk", async () => {
  const sent: string[] = [];
  const text = `intro\n${"x".repeat(2_100)}`;
  const worker = new DiscordDeliveryWorker({
    async listPendingDeliveries() { return [{ id: "d", runId: "r", destination: { kind: "discord", channelId: "c" }, payload: { text, artifactIds: ["a"] }, state: "pending" as const, createdAt: "now" }]; },
    async markDeliveryDelivered() {},
    async markDeliveryFailed() {},
  }, {
    async sendText(_channelId, chunk) { sent.push(`text:${chunk}`); return { messageId: "text" }; },
    async sendFiles(_channelId, _files, chunk) { sent.push(`files:${chunk}`); return { messageId: "files" }; },
  }, () => "later", {
    async getArtifact() { return { id: "a", ownerPrincipalId: "owner", visibility: "shared", mediaType: "image/png", filename: "image.png", size: 1, sha256: "a".repeat(64), location: "/safe/image", state: "stored", createdAt: "now", updatedAt: "now" }; },
  });
  assert.deepEqual(await worker.drain(), { delivered: 1, skipped: 0 });
  assert.equal(sent.length, 2);
  assert.ok(sent[0]?.startsWith("text:intro"));
  assert.ok(sent[1]?.startsWith("files:"));
  assert.equal(sent.map(item => item.slice(item.indexOf(":") + 1)).join(""), text);
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
