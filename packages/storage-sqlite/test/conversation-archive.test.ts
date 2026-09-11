import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SQLiteExecutionStore } from "../src/index.js";

const event = (id: string) => ({ id, occurredAt: "2026-09-09T00:00:00.000Z", identity: { transport: "discord", externalId: "user", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" as const }, content: [{ type: "text" as const, text: id }] });

test("archiving keeps canonical turns and the next ingress starts a new conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-archive-")); const store = new SQLiteExecutionStore(join(directory, "db.sqlite"));
  try {
    const first = await store.ingestInputEvent({ event: event("e1"), actorPrincipalId: "owner", newConversationId: "c1", newTurnId: "t1", newRunId: "r1", createdAt: "2026-09-09T00:00:00.000Z" });
    assert.equal(first.conversationCreated, true);
    assert.deepEqual(await store.getConversationBinding("c1"), { transport: "discord", externalId: "channel", kind: "channel" });
    assert.equal(await store.getConversationBinding("missing"), undefined);
    assert.deepEqual(await store.listConversationBindings("discord"), [{ transport: "discord", externalId: "channel", kind: "channel", conversationId: "c1" }]);
    assert.equal((await store.archiveBoundConversation("discord", "channel", "2026-09-09T00:01:00.000Z"))?.state, "archived");
    assert.equal((await store.listTurns("c1")).length, 1);
    const second = await store.ingestInputEvent({ event: event("e2"), actorPrincipalId: "owner", newConversationId: "c2", newTurnId: "t2", newRunId: "r2", createdAt: "2026-09-09T00:02:00.000Z" });
    assert.equal(second.conversationCreated, true);
    assert.equal(second.conversation.id, "c2");
    assert.equal((await store.getConversation("c1"))?.state, "archived");
    assert.deepEqual(await store.listConversationBindings("discord"), [{ transport: "discord", externalId: "channel", kind: "channel", conversationId: "c2" }]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("thread starter seed is inserted once before the triggering Turn", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    const first = await store.ingestInputEvent({
      event: event("discord:reply"), actorPrincipalId: "reply-author", newConversationId: "thread-conversation", newTurnId: "reply-turn", newRunId: "reply-run", createdAt: "2026-09-09T00:01:00.000Z",
      initialTurns: [{ id: "starter-turn", actorPrincipalId: "starter-author", actorIdentity: { transport: "discord", externalId: "starter" }, inputEventId: "discord:starter:thread", content: [{ type: "text", text: "thread starter" }], createdAt: "2026-09-09T00:00:00.000Z" }],
    });
    assert.equal(first.conversationCreated, true);
    assert.equal((await store.listTurns("thread-conversation")).map(turn => `${turn.sequence}:${turn.inputEventId}`).join(","), "0:discord:starter:thread,1:discord:reply");
    assert.equal(await store.hasConversationBinding("discord", "channel"), true);
    const second = await store.ingestInputEvent({ event: event("discord:next"), actorPrincipalId: "reply-author", newConversationId: "unused", newTurnId: "next-turn", newRunId: "next-run", createdAt: "2026-09-09T00:02:00.000Z", initialTurns: [{ id: "must-not-insert", actorPrincipalId: "starter-author", inputEventId: "discord:starter:other", content: [{ type: "text", text: "ignored" }], createdAt: "2026-09-09T00:00:00.000Z" }] });
    assert.equal(second.turn.sequence, 2);
    assert.equal((await store.listTurns("thread-conversation")).length, 3);
  } finally { store.close(); }
});

test("resolves Discord replies to a canonical Turn, including replies to bot deliveries", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    const first = await store.ingestInputEvent({ event: { ...event("discord:one"), content: [{ type: "text", text: "原始問題" }] }, actorPrincipalId: "member", newConversationId: "c", newTurnId: "t1", newRunId: "r1", createdAt: "2026-09-09T00:00:00.000Z" });
    const second = await store.ingestInputEvent({ event: { ...event("discord:two"), replyToExternalId: "one", content: [{ type: "text", text: "這則呢" }] }, actorPrincipalId: "member", newConversationId: "unused", newTurnId: "t2", newRunId: "r2", createdAt: "2026-09-09T00:01:00.000Z" });
    assert.equal(second.turn.replyToTurnId, first.turn.id);
    assert.deepEqual(await store.getHistoryItem(first.turn.id), { turn: first.turn });
  } finally { store.close(); }
});

test("session model and queue preferences survive conversation archive", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    const first = await store.updateConversationPreferences({ transport: "discord", externalId: "channel", expectedRevision: 0, model: "model-a", reasoningEffort: "high", queueMode: "steer", updatedAt: "2026-09-09T00:00:00.000Z" });
    assert.equal(first.revision, 1);
    await store.ingestInputEvent({ event: event("e1"), actorPrincipalId: "owner", newConversationId: "c1", newTurnId: "t1", newRunId: "r1", createdAt: "2026-09-09T00:00:00.000Z" });
    await store.archiveBoundConversation("discord", "channel", "2026-09-09T00:01:00.000Z");
    assert.deepEqual(await store.getConversationPreferences("discord", "channel"), first);
    const second = await store.updateConversationPreferences({ transport: "discord", externalId: "channel", expectedRevision: 1, queueMode: "queue", updatedAt: "2026-09-09T00:02:00.000Z" });
    assert.deepEqual(second, { transport: "discord", externalId: "channel", revision: 2, queueMode: "queue", updatedAt: "2026-09-09T00:02:00.000Z" });
  } finally { store.close(); }
});
