import assert from "node:assert/strict";
import test from "node:test";
import { SemanticRecallProvider } from "../src/semantic-recall.js";
import type { LogRecord } from "@umiro/core/observability";

const request = (signal?: AbortSignal) => ({ runId: "r", prompt: "上次怎麼決定？", execution: { actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, origin: { kind: "interactive" as const, transport: "discord", conversationId: "current" }, authority: { capabilities: [], visibility: { kind: "all" as const }, instructionAuthority: "full" as const } }, maxCharacters: 10_000, ...(signal ? { signal } : {}) });

test("automatic recall is semantic-only, bounded, filtered and untrusted", async () => {
  let options: unknown;
  const provider = new SemanticRecallProvider({
    async prepareEmbeddingModel() {}, async claimEmbeddingJobs() { return []; }, async completeEmbeddingJob() {}, async failEmbeddingJob() {}, async rebuildEmbeddingProjection() {},
    async semanticSearch(_vector, _model, limit, _visibility, input) { options = input; assert.equal(limit, 5); return [{ turnId: "old", conversationId: "previous", actorPrincipalId: "owner", text: "上次決定用 SQLite", rank: 0.1, semanticScore: 0.9 }]; },
  }, { model: "gemini-embedding-2", async embed(text) { assert.equal(text, "上次怎麼決定？"); return [1, 0]; } }, () => new Date("2026-09-09T00:00:00.000Z"));
  const blocks = await provider.load(request());
  assert.deepEqual(options, { excludeConversationId: "current", minSimilarity: 0.55 });
  assert.match(blocks[0]?.content ?? "", /trust="untrusted-data"[\s\S]*上次決定用 SQLite/);
});

test("automatic recall forwards configured model-specific threshold and limit", async () => {
  let observed: unknown;
  const provider = new SemanticRecallProvider({
    async prepareEmbeddingModel() {}, async claimEmbeddingJobs() { return []; }, async completeEmbeddingJob() {}, async failEmbeddingJob() {}, async rebuildEmbeddingProjection() {},
    async semanticSearch(_vector, _model, limit, _visibility, options) { observed = { limit, options }; return []; },
  }, { model: "custom", async embed() { return [1]; } }, undefined, undefined, { limit: 3, minSimilarity: 0.42 });
  assert.deepEqual(await provider.load(request()), []);
  assert.deepEqual(observed, { limit: 3, options: { excludeConversationId: "current", minSimilarity: 0.42 } });
});

test("automatic recall logs a redacted dependency failure and returns no optional context", async () => {
  const records: LogRecord[] = [];
  const provider = new SemanticRecallProvider({
    async prepareEmbeddingModel() {}, async claimEmbeddingJobs() { return []; }, async completeEmbeddingJob() {}, async failEmbeddingJob() {}, async rebuildEmbeddingProjection() {}, async semanticSearch() { return []; },
  }, { model: "broken", async embed() { throw new Error("query and api-key must not leak"); } }, () => new Date("2026-09-09T00:00:00.000Z"), { write(record) { records.push(record); } });

  assert.deepEqual(await provider.load(request()), []);
  assert.equal(records[0]?.event, "embedding.recall.degraded");
  assert.equal(records[0]?.runId, "r");
  assert.doesNotMatch(JSON.stringify(records), /api-key|must not leak|上次怎麼決定/);
});

test("automatic recall yields when interactive embedding exceeds its latency budget", async () => {
  const provider = new SemanticRecallProvider({
    async prepareEmbeddingModel() {}, async claimEmbeddingJobs() { return []; }, async completeEmbeddingJob() {}, async failEmbeddingJob() {}, async rebuildEmbeddingProjection() {}, async semanticSearch() { return []; },
  }, { model: "slow", embed: (_text, signal) => new Promise<readonly number[]>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })) }, undefined, undefined, { timeoutMs: 10 });
  const started = Date.now();
  assert.deepEqual(await provider.load(request()), []);
  assert.ok(Date.now() - started < 250);
});

test("automatic recall does not swallow caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  const provider = new SemanticRecallProvider({
    async prepareEmbeddingModel() {}, async claimEmbeddingJobs() { return []; }, async completeEmbeddingJob() {}, async failEmbeddingJob() {}, async rebuildEmbeddingProjection() {}, async semanticSearch() { return []; },
  }, { model: "broken", async embed(_text, signal) { throw signal?.reason; } });
  await assert.rejects(provider.load(request(controller.signal)), /caller cancelled/);
});
