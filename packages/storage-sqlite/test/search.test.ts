import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteExecutionStore } from "../src/index.js";

test("indexes conversation turns and rebuilds the FTS projection", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  await store.createConversationWithTurn(
    { id: "c", revision: 0, state: "active", createdAt: "now", updatedAt: "now" },
    { id: "t", conversationId: "c", sequence: 0, actorPrincipalId: "p", inputEventId: "e", content: [{ type: "text", text: "今天一起去公園散步" }], createdAt: "now" },
  );
  assert.equal((await store.search("公園", 10))[0]?.turnId, "t");
  await store.rebuildSearchProjection();
  assert.equal((await store.search("散步", 10))[0]?.conversationId, "c");
  store.close();
});
