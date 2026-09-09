import assert from "node:assert/strict";
import test from "node:test";
import { SemanticRecallProvider } from "../src/semantic-recall.js";

test("automatic recall is semantic-only, bounded, filtered and untrusted", async () => {
  let options: unknown;
  const provider = new SemanticRecallProvider({
    async claimEmbeddingJobs() { return []; }, async completeEmbeddingJob() {}, async failEmbeddingJob() {}, async rebuildEmbeddingProjection() {},
    async semanticSearch(_vector, _model, limit, _visibility, input) { options = input; assert.equal(limit, 5); return [{ turnId: "old", conversationId: "previous", actorPrincipalId: "owner", text: "上次決定用 SQLite", rank: 0.1, semanticScore: 0.9 }]; },
  }, { model: "gemini-embedding-2", async embed(text) { assert.equal(text, "上次怎麼決定？"); return [1, 0]; } }, () => new Date("2026-09-09T00:00:00.000Z"));
  const blocks = await provider.load({ runId: "r", prompt: "上次怎麼決定？", execution: { actor: { id: "owner", kind: "human", roles: ["owner"] }, origin: { kind: "interactive", transport: "discord", conversationId: "current" }, authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" } } });
  assert.deepEqual(options, { excludeConversationId: "current", beforeCreatedAt: "2026-09-07T00:00:00.000Z", minSimilarity: 0.68 });
  assert.match(blocks[0]?.content ?? "", /trust="untrusted-data"[\s\S]*上次決定用 SQLite/);
});
