import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { EmbeddingWorker, HybridConversationSearch } from "../src/embedding-worker.js";
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
