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

test("indexes durable extracted attachment text through Turn artifact references", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createArtifact({ artifact: { id: "artifact", ownerPrincipalId: "alice", visibility: "shared", mediaType: "text/plain", filename: "deploy.txt", size: 18, sha256: "a".repeat(64), location: "/unused", extractedText: "deployment evidence from attachment", parentSource: { kind: "discord_message", id: "message" }, state: "stored", createdAt: "now", updatedAt: "now" } });
  await store.createConversationWithTurn(
    { id: "c", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t", conversationId: "c", sequence: 0, actorPrincipalId: "alice", inputEventId: "e", content: [{ type: "text", text: "請看附件" }, { type: "artifact_reference", artifactId: "artifact" }], createdAt: "now" },
  );
  const hit = (await store.search("deployment evidence", 10, { kind: "all" }))[0];
  assert.equal(hit?.turnId, "t");
  assert.match(hit?.text ?? "", /Attachment: deploy\.txt[\s\S]*deployment evidence/);
  const [job] = await store.claimEmbeddingJobs(10, "2026-01-01T00:00:00.000Z", "2025-12-31T23:55:00.000Z");
  assert.match(job?.text ?? "", /deployment evidence/);
  await store.rebuildSearchProjection();
  assert.equal((await store.search("deployment evidence", 10, { kind: "all" }))[0]?.turnId, "t");
  store.close();
});

test("namespace-scoped Plugin documents are searchable, replaceable, removable, and visibility-aware", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.replaceSearchSource("context-files", "OWNER.md", [{ id: "OWNER.md", sourceType: "workspace_file", sourceId: "OWNER.md", text: "owner prefers concise reports", visibility: { kind: "all" } }]);
  await store.replaceSearchSource("memory", "memory/FACTS.md", [
    { id: "fact-one", sourceType: "workspace_file", sourceId: "memory/FACTS.md#Home city", text: "Home city\nKobe harbor fact", visibility: { kind: "all" } },
    { id: "fact-two", sourceType: "workspace_file", sourceId: "memory/FACTS.md#Favorite dish", text: "Favorite dish\nAkashiyaki fact", visibility: { kind: "all" } },
  ]);
  await store.replaceSearchSource("people", "PEOPLE.md", [{ id: "PEOPLE.md", sourceType: "workspace_file", sourceId: "PEOPLE.md", text: "Alice prefers tea", visibility: { kind: "restricted", principalIds: ["alice"], labels: [], resources: [] } }]);
  assert.equal((await store.search("concise reports", 10, { kind: "all" }))[0]?.sourceType, "workspace_file");
  assert.equal((await store.search("Kobe harbor", 10, { kind: "all" }))[0]?.sourceId, "memory/FACTS.md#Home city");
  assert.equal((await store.search("tea", 10, { kind: "restricted", principalIds: ["bob"], labels: [], resources: [] })).length, 0);
  assert.equal((await store.search("tea", 10, { kind: "restricted", principalIds: ["alice"], labels: [], resources: [] }))[0]?.documentId, "PEOPLE.md");
  await store.replaceSearchSource("context-files", "OWNER.md", [{ id: "OWNER.md", sourceType: "workspace_file", sourceId: "OWNER.md", text: "owner prefers detailed reports", visibility: { kind: "all" } }]);
  await store.replaceSearchSource("memory", "memory/FACTS.md", [{ id: "fact-one", sourceType: "workspace_file", sourceId: "memory/FACTS.md#Home city", text: "Home city\nKobe port fact", visibility: { kind: "all" } }]);
  assert.equal((await store.search("concise", 10, { kind: "all" })).length, 0);
  assert.equal((await store.search("Akashiyaki", 10, { kind: "all" })).length, 0);
  assert.deepEqual(await store.listSearchNamespaces(), ["context-files", "memory", "people"]);
  await store.removeSearchSource("people", "PEOPLE.md");
  assert.equal((await store.search("tea", 10, { kind: "all" })).length, 0);
  await store.replaceSearchSource("people", "PEOPLE.md", [{ id: "PEOPLE.md", sourceType: "workspace_file", sourceId: "PEOPLE.md", text: "Alice prefers coffee", visibility: { kind: "all" } }]);
  await store.removeSearchNamespace("people");
  assert.deepEqual(await store.listSearchNamespaces(), ["context-files", "memory"]);
  assert.equal((await store.search("coffee", 10, { kind: "all" })).length, 0);
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
  assert.equal(job?.documentKey, "turn:t");
  await store.completeEmbeddingJob(job!.documentKey, job!.contentHash, "model", [1, 0], "2026-01-01T00:00:01.000Z");
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

test("one memory entry keeps its source identity through semantic projection", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.replaceSearchSource("memory", "memory/FACTS.md", [{ id: "fact-kobe", sourceType: "workspace_file", sourceId: "memory/FACTS.md#Kobe trip", text: "Kobe trip\nThe hotel is beside Sannomiya station.", visibility: { kind: "all" } }]);
  const [job] = await store.claimEmbeddingJobs(10, "2026-01-01T00:00:00.000Z", "2025-12-31T23:55:00.000Z");
  assert.equal(job?.documentKey, "document:memory:fact-kobe");
  await store.completeEmbeddingJob(job!.documentKey, job!.contentHash, "model", [1, 0], "2026-01-01T00:00:01.000Z");
  const [hit] = await store.semanticSearch([1, 0], "model", 5, { kind: "all" });
  assert.equal(hit?.sourceType, "workspace_file");
  assert.equal(hit?.sourceId, "memory/FACTS.md#Kobe trip");
  store.close();
});

test("query dimension mismatch fails without deleting the document index", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createConversationWithTurn(
    { id: "c", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t", conversationId: "c", sequence: 0, actorPrincipalId: "p", inputEventId: "e", content: [{ type: "text", text: "stable vector space" }], createdAt: "now" },
  );
  const [job] = await store.claimEmbeddingJobs(10, "now", "before");
  await store.completeEmbeddingJob(job!.documentKey, job!.contentHash, "space:1024", [1, 0], "now");
  await assert.rejects(store.semanticSearch([1, 0, 0], "space:1024", 5, { kind: "all" }), /dimensions/);
  assert.equal((await store.semanticSearch([1, 0], "space:1024", 5, { kind: "all" }))[0]?.turnId, "t");
  store.close();
});
