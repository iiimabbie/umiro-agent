import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteExecutionStore } from "../src/index.js";

test("indexes conversation turns and rebuilds the FTS projection", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createConversationWithTurn(
    { id: "c", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t", conversationId: "c", sequence: 0, actorPrincipalId: "p", inputEventId: "e", content: [{ type: "text", text: "今天一起去公園散步" }], createdAt: "now" },
  );
  assert.equal((await store.search("公園", 10, { kind: "all" }))[0]?.turnId, "t");
  await store.rebuildSearchProjection();
  assert.equal((await store.search("散步", 10, { kind: "all" }))[0]?.conversationId, "c");
  store.close();
});

test("search enforces principal and conversation visibility inside SQLite", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createConversationWithTurn(
    { id: "c1", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t1", conversationId: "c1", sequence: 0, actorPrincipalId: "alice", inputEventId: "e1", content: [{ type: "text", text: "private alpha evidence" }], createdAt: "now" },
  );
  await store.createConversationWithTurn(
    { id: "c2", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t2", conversationId: "c2", sequence: 0, actorPrincipalId: "bob", inputEventId: "e2", content: [{ type: "text", text: "private alpha evidence" }], createdAt: "now" },
  );
  const restricted = { kind: "restricted" as const, principalIds: ["alice"], labels: [], resources: [] };
  assert.deepEqual((await store.search("alpha", 10, restricted)).map(hit => hit.turnId), ["t1"]);
  const byConversation = { kind: "restricted" as const, principalIds: [], labels: [], resources: [{ kind: "conversation", id: "c2" }] };
  assert.deepEqual((await store.search("alpha", 10, byConversation)).map(hit => hit.turnId), ["t2"]);
  store.close();
});

test("embedding jobs survive as a rebuildable visibility-aware projection", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createConversationWithTurn(
    { id: "c", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t", conversationId: "c", sequence: 0, actorPrincipalId: "alice", inputEventId: "e", content: [{ type: "text", text: "semantic memory" }], createdAt: "now" },
  );
  const [job] = await store.claimEmbeddingJobs(10, "2026-01-01T00:00:00.000Z", "2025-12-31T23:55:00.000Z");
  assert.equal(job?.turnId, "t");
  await store.completeEmbeddingJob("t", job!.contentHash, "model", [1, 0], "2026-01-01T00:00:01.000Z");
  assert.equal((await store.semanticSearch([0.9, 0.1], "model", 10, { kind: "all" }))[0]?.turnId, "t");
  assert.equal((await store.semanticSearch([1, 0], "model", 10, { kind: "restricted", principalIds: ["bob"], labels: [], resources: [] })).length, 0);
  await store.prepareEmbeddingModel("model");
  assert.equal((await store.claimEmbeddingJobs(10, "2026-01-01T00:00:30.000Z", "2025-12-31T23:55:30.000Z")).length, 0);
  await store.prepareEmbeddingModel("different-provider:model");
  assert.equal((await store.claimEmbeddingJobs(10, "2026-01-01T00:00:31.000Z", "2025-12-31T23:55:31.000Z")).length, 1);
  await store.rebuildEmbeddingProjection();
  assert.equal((await store.claimEmbeddingJobs(10, "2026-01-01T00:01:00.000Z", "2025-12-31T23:56:00.000Z")).length, 1);
  store.close();
});
