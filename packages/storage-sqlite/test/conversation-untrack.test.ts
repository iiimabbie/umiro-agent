import assert from "node:assert/strict";
import test from "node:test";
import type { InputEvent } from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

const event = (id: string, externalId = "channel"): InputEvent => ({
  id,
  occurredAt: "2026-09-21T00:00:00.000Z",
  identity: { transport: "discord", externalId: "owner", principalId: null },
  conversation: { transport: "discord", externalId, kind: "channel" },
  content: [{ type: "text", text: id }],
});

test("untrack archives the active conversation, removes binding and scope, and preserves history/preferences", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    await store.updateConversationPreferences({ transport: "discord", externalId: "channel", expectedRevision: 0, model: "model-a", reasoningEffort: "high", queueMode: "steer", updatedAt: "2026-09-21T00:00:00.000Z" });
    const first = await store.ingestInputEvent({ event: event("first"), actorPrincipalId: "owner", newConversationId: "conversation-1", newTurnId: "turn-1", newRunId: "run-1", createdAt: "2026-09-21T00:01:00.000Z" });
    const result = await store.untrackConversationScope({ transport: "discord", externalId: "channel", archivedAt: "2026-09-21T00:02:00.000Z" });
    assert.deepEqual(result, { tracked: true, archivedConversationId: "conversation-1" });
    assert.equal((await store.getConversation("conversation-1"))?.state, "archived");
    assert.equal((await store.getConversation("conversation-1"))?.revision, first.conversation.revision + 1);
    assert.equal(await store.getConversationBinding("conversation-1"), undefined);
    assert.deepEqual(await store.listConversationScopes("discord"), []);
    assert.deepEqual((await store.listTurns("conversation-1")).map(turn => turn.id), ["turn-1"]);
    assert.deepEqual((await store.listConversations({ transport: "discord", externalId: "channel", state: "archived" })).map(item => item.conversation.id), ["conversation-1"]);
    assert.deepEqual(await store.getConversationPreferences("discord", "channel"), { transport: "discord", externalId: "channel", revision: 1, model: "model-a", reasoningEffort: "high", queueMode: "steer", updatedAt: "2026-09-21T00:00:00.000Z" });
    assert.deepEqual(await store.untrackConversationScope({ transport: "discord", externalId: "channel", archivedAt: "2026-09-21T00:03:00.000Z" }), { tracked: false });
    assert.equal((await store.getConversation("conversation-1"))?.updatedAt, "2026-09-21T00:02:00.000Z");
  } finally { store.close(); }
});

test("untracked scopes ignore ordinary observations but explicit ingress tracks again", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    await store.ingestInputEvent({ event: event("first"), actorPrincipalId: "owner", newConversationId: "conversation-1", newTurnId: "turn-1", newRunId: "run-1", createdAt: "2026-09-21T00:01:00.000Z" });
    await store.untrackConversationScope({ transport: "discord", externalId: "channel", archivedAt: "2026-09-21T00:02:00.000Z" });
    assert.equal(await store.observeInputEvent({ event: event("ordinary"), actorPrincipalId: "member", newConversationId: "must-not-exist", newTurnId: "must-not-exist", createdAt: "2026-09-21T00:03:00.000Z" }), undefined);
    const explicitlyTracked = await store.observeInputEvent({ event: event("mention-observed"), actorPrincipalId: "owner", newConversationId: "conversation-2", newTurnId: "turn-2", createdAt: "2026-09-21T00:04:00.000Z", establishScope: true });
    assert.equal(explicitlyTracked?.conversationCreated, true);
    await store.untrackConversationScope({ transport: "discord", externalId: "channel", archivedAt: "2026-09-21T00:05:00.000Z" });
    const retracked = await store.ingestInputEvent({ event: event("mention"), actorPrincipalId: "owner", newConversationId: "conversation-3", newTurnId: "turn-3", newRunId: "run-3", createdAt: "2026-09-21T00:06:00.000Z" });
    assert.equal(retracked.conversationCreated, true);
    assert.equal(retracked.conversation.id, "conversation-3");
    assert.deepEqual(await store.listConversationScopes("discord"), [{ transport: "discord", externalId: "channel", kind: "channel" }]);
    assert.equal(await store.getConversationPreferences("discord", "channel"), undefined);
  } finally { store.close(); }
});

test("untrack removes an established scope even when its active binding was already archived", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    await store.ingestInputEvent({ event: event("first"), actorPrincipalId: "owner", newConversationId: "conversation-1", newTurnId: "turn-1", newRunId: "run-1", createdAt: "2026-09-21T00:01:00.000Z" });
    await store.archiveBoundConversation("discord", "channel", "2026-09-21T00:02:00.000Z");
    assert.deepEqual(await store.untrackConversationScope({ transport: "discord", externalId: "channel", archivedAt: "2026-09-21T00:03:00.000Z" }), { tracked: true });
    assert.deepEqual(await store.listConversationScopes("discord"), []);
    assert.equal((await store.getConversation("conversation-1"))?.state, "archived");
  } finally { store.close(); }
});
