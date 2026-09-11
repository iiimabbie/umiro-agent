import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { EmbeddingWorker, HybridConversationSearch, RateLimitedTextEmbedder } from "../src/embedding-worker.js";
import type { LogRecord } from "@umiro/core/observability";

test("embedding worker drains durable jobs and hybrid search returns semantic evidence", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createConversationWithTurn(
    { id: "c", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t", conversationId: "c", sequence: 0, actorPrincipalId: "p", inputEventId: "e", content: [{ type: "text", text: "a remembered bicycle" }], createdAt: "now" },
  );
  const embedder = { model: "fake", async embed(text: string) { return text.includes("bicycle") || text.includes("vehicle") ? [1, 0] : [0, 1]; } };
  assert.equal(await new EmbeddingWorker(store, embedder).drain(), 1);
  const hits = await new HybridConversationSearch(store, embedder).search("vehicle", 5, { kind: "all" });
  assert.equal(hits[0]?.turnId, "t");
  store.close();
});

test("embedding worker uses one batch request for a claimed projection page", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  for (let index = 0; index < 3; index++) {
    await store.createConversationWithTurn(
      { id: `c${index}`, revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
      { id: `t${index}`, conversationId: `c${index}`, sequence: 0, actorPrincipalId: "p", inputEventId: `e${index}`, content: [{ type: "text", text: `document ${index}` }], createdAt: "now" },
    );
  }
  const batches: string[][] = [];
  const embedder = {
    model: "batch",
    async embed() { throw new Error("single embedding path must not run"); },
    async embedMany(texts: readonly string[]) { batches.push([...texts]); return texts.map((_text, index) => [index, 1]); },
  };
  assert.equal(await new EmbeddingWorker(store, embedder).drain(), 3);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 3);
  store.close();
});

test("embedding failures are observable, redacted, and safely degrade to FTS", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createConversationWithTurn(
    { id: "c", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t", conversationId: "c", sequence: 0, actorPrincipalId: "p", inputEventId: "e", content: [{ type: "text", text: "lexical bicycle evidence" }], createdAt: "now" },
  );
  const records: LogRecord[] = [];
  const logger = { write(record: LogRecord) { records.push(record); } };
  const embedder = { model: "broken", async embed() { throw new Error("api-key=do-not-log"); } };

  assert.equal(await new EmbeddingWorker(store, embedder, 15_000, logger).drain(), 0);
  const hits = await new HybridConversationSearch(store, embedder, logger).search("bicycle", 5, { kind: "all" });

  assert.equal(hits[0]?.turnId, "t");
  assert.deepEqual(records.map(record => record.event), ["embedding.job.failed", "embedding.search.degraded"]);
  assert.doesNotMatch(JSON.stringify(records), /api-key|do-not-log/);
  store.close();
});

test("embedding rate limiter spaces provider calls and prioritizes foreground recall", async () => {
  let now = 0; let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scheduler = {
    now: () => now,
    setTimeout(callback: () => void, delayMs: number) { const id = ++timerId; timers.set(id, { at: now + delayMs, callback }); return id; },
    clearTimeout(handle: unknown) { timers.delete(Number(handle)); },
    advance(ms: number) { now += ms; for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
  };
  const calls: string[] = [];
  const inner = { model: "limited", async embed(text: string) { calls.push(text); return [calls.length]; }, async embedMany(texts: readonly string[]) { calls.push(texts.join(",")); return texts.map((_text, index) => [index]); } };
  const limited = new RateLimitedTextEmbedder(inner, 3, scheduler);
  const background = limited.forBackground();

  await background.embedMany!(["background-1"]);
  const queuedBackground = background.embed("background-2");
  const foreground = limited.embed("foreground");
  assert.deepEqual(calls, ["background-1"]);
  scheduler.advance(20_000); await foreground;
  assert.deepEqual(calls, ["background-1", "foreground"]);
  scheduler.advance(20_000); await queuedBackground;
  assert.deepEqual(calls, ["background-1", "foreground", "background-2"]);
});

test("embedding rate limiter cancels a queued request without waiting for its slot", async () => {
  let now = 0; let callback: (() => void) | undefined;
  const scheduler = { now: () => now, setTimeout(next: () => void) { callback = next; return 1; }, clearTimeout() { callback = undefined; } };
  const calls: string[] = [];
  const limited = new RateLimitedTextEmbedder({ model: "limited", async embed(text: string) { calls.push(text); return [1]; } }, 1, scheduler);
  await limited.embed("first");
  const controller = new AbortController();
  const waiting = limited.embed("cancelled", controller.signal);
  controller.abort(new Error("caller stopped"));
  await assert.rejects(waiting, /caller stopped/);
  now = 60_000; callback?.();
  await Promise.resolve();
  assert.deepEqual(calls, ["first"]);
});
