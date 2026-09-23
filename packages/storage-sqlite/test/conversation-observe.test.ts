import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InputEvent } from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

function event(id: string): InputEvent {
  return { id, occurredAt: "2026-09-09T00:00:00.000Z", identity: { transport: "discord", externalId: "member", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" }, content: [{ type: "text", text: id }] };
}

test("observe records a Turn only for an existing Conversation and never creates a Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-observe-"));
  const store = new SQLiteExecutionStore(join(root, "state.sqlite"));
  try {
    assert.equal(await store.observeInputEvent({ event: event("before"), actorPrincipalId: "member", newConversationId: "unused", newTurnId: "unused", createdAt: "2026-09-09T00:00:00.000Z" }), undefined);
    const triggered = await store.ingestInputEvent({ event: event("trigger"), actorPrincipalId: "member", newConversationId: "conversation", newTurnId: "trigger-turn", newRunId: "run", createdAt: "2026-09-09T00:01:00.000Z" });
    const observed = await store.observeInputEvent({ event: event("ambient"), actorPrincipalId: "member", newConversationId: "unused", newTurnId: "ambient-turn", createdAt: "2026-09-09T00:02:00.000Z" });
    assert.equal(observed?.conversation.id, triggered.conversation.id);
    assert.equal(observed?.turn.primaryRunId, undefined);
    assert.equal(observed?.turn.sequence, 1);
    assert.equal((await store.listRecentHistory(triggered.conversation.id, 2, 10)).length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an untriggered channel is never recorded, while an archived established scope opens a fresh observed Conversation", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    assert.equal(await store.observeInputEvent({ event: event("unrelated"), actorPrincipalId: "member", newConversationId: "must-not-exist", newTurnId: "must-not-exist", createdAt: "2026-09-09T00:00:00.000Z" }), undefined);
    assert.equal(await store.hasConversationScope("discord", "channel"), false);
    await store.ingestInputEvent({ event: event("trigger"), actorPrincipalId: "member", newConversationId: "first", newTurnId: "trigger-turn", newRunId: "run", createdAt: "2026-09-09T00:01:00.000Z" });
    assert.equal(await store.hasConversationScope("discord", "channel"), true);
    await store.archiveBoundConversation("discord", "channel", "2026-09-09T00:02:00.000Z");
    assert.equal(await store.hasConversationScope("discord", "channel"), true);
    const observed = await store.observeInputEvent({ event: event("after-archive"), actorPrincipalId: "member", newConversationId: "second", newTurnId: "observed-turn", createdAt: "2026-09-09T00:03:00.000Z" });
    assert.equal(observed?.conversationCreated, true);
    assert.equal(observed?.conversation.id, "second");
    assert.equal(observed?.turn.primaryRunId, undefined);
    assert.deepEqual(await store.listConversationBindings("discord"), [{ transport: "discord", externalId: "channel", kind: "channel", conversationId: "second" }]);
    assert.deepEqual(await store.listConversationScopes("discord"), [{ transport: "discord", externalId: "channel", kind: "channel" }]);
  } finally { store.close(); }
});

test("observing into a new thread stores the starter before the first observed message and retains bot authorship", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    await store.ingestInputEvent({ event: event("trigger"), actorPrincipalId: "member", newConversationId: "old", newTurnId: "old-turn", newRunId: "run", createdAt: "2026-09-09T00:00:00.000Z" });
    await store.archiveBoundConversation("discord", "channel", "2026-09-09T00:01:00.000Z");
    const message = { ...event("observed"), conversation: { transport: "discord", externalId: "channel", kind: "thread" as const }, metadata: { authorBot: true } };
    const result = await store.observeInputEvent({ event: message, actorPrincipalId: "bot-principal", newConversationId: "new", newTurnId: "observed-turn", createdAt: "2026-09-09T00:02:00.000Z", initialTurns: [{ id: "starter-turn", actorPrincipalId: "starter-author", actorIdentity: { transport: "discord", externalId: "starter" }, inputEventId: "discord:starter:starter:event", content: [{ type: "text", text: "starter text" }], createdAt: "2026-09-09T00:00:30.000Z" }] });
    assert.equal(result?.turn.sequence, 1);
    assert.equal(result?.turn.authorIsBot, true);
    assert.equal((await store.listTurns("new"))[0]?.content[0]?.type, "text");
    assert.equal((await store.listTurns("new"))[0]?.id, "starter-turn");
  } finally { store.close(); }
});
