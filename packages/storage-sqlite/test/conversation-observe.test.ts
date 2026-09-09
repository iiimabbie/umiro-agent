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
