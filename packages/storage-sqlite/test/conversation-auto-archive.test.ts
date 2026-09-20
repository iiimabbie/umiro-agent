import assert from "node:assert/strict";
import test from "node:test";
import type { InputEvent } from "@umiro/core";
import { SQLiteExecutionStore } from "../src/index.js";

function event(id: string, externalId: string, at: string): InputEvent {
  return { id, occurredAt: at, identity: { transport: "discord", externalId: "owner", principalId: null }, conversation: { transport: "discord", externalId, kind: "channel" }, content: [{ type: "text", text: id }] };
}

test("archives eligible Discord bindings atomically, defers exclusions, and is idempotent", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    await store.ingestInputEvent({ event: event("one", "channel-one", "2026-09-09T00:00:00.000Z"), actorPrincipalId: "owner", newConversationId: "one", newTurnId: "turn-one", newRunId: "run-one", createdAt: "2026-09-09T00:00:00.000Z" });
    await store.ingestInputEvent({ event: event("two", "channel-two", "2026-09-09T00:01:00.000Z"), actorPrincipalId: "owner", newConversationId: "two", newTurnId: "turn-two", newRunId: "run-two", createdAt: "2026-09-09T00:01:00.000Z" });
    const first = await store.archiveActiveConversationsBefore({ transport: "discord", cutoff: "2026-09-09T00:01:00.000Z", archivedAt: "2026-09-09T00:02:00.000Z", excludeExternalIds: ["channel-two"] });
    assert.deepEqual(first.archived, [{ conversationId: "one", externalId: "channel-one" }]);
    assert.deepEqual(first.skipped, [{ conversationId: "two", externalId: "channel-two" }]);
    assert.equal((await store.getConversation("one"))?.state, "archived");
    assert.equal((await store.getConversation("two"))?.state, "active");
    assert.deepEqual(await store.archiveActiveConversationsBefore({ transport: "discord", cutoff: "2026-09-09T00:01:00.000Z", archivedAt: "2026-09-09T00:03:00.000Z", excludeExternalIds: ["channel-two"] }), { archived: [], skipped: [{ conversationId: "two", externalId: "channel-two" }] });
  } finally { store.close(); }
});

test("an old cutoff cannot archive a replacement conversation", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    await store.ingestInputEvent({ event: event("old", "channel", "2026-09-09T00:00:00.000Z"), actorPrincipalId: "owner", newConversationId: "old", newTurnId: "old-turn", newRunId: "old-run", createdAt: "2026-09-09T00:00:00.000Z" });
    await store.archiveActiveConversationsBefore({ transport: "discord", cutoff: "2026-09-09T00:00:00.000Z", archivedAt: "2026-09-09T00:01:00.000Z" });
    await store.ingestInputEvent({ event: event("new", "channel", "2026-09-09T00:02:00.000Z"), actorPrincipalId: "owner", newConversationId: "new", newTurnId: "new-turn", newRunId: "new-run", createdAt: "2026-09-09T00:02:00.000Z" });
    assert.deepEqual(await store.archiveActiveConversationsBefore({ transport: "discord", cutoff: "2026-09-09T00:01:00.000Z", archivedAt: "2026-09-09T00:03:00.000Z", externalIds: ["channel"] }), { archived: [], skipped: [] });
    assert.equal((await store.getConversation("new"))?.state, "active");
  } finally { store.close(); }
});

test("deferred archive targets the conversation captured at cutoff and permits its run to finish", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    await store.ingestInputEvent({ event: event("old", "channel", "2026-09-09T00:00:00.000Z"), actorPrincipalId: "owner", newConversationId: "old", newTurnId: "old-turn", newRunId: "old-run", createdAt: "2026-09-09T00:00:00.000Z" });
    assert.ok(await store.archiveBoundConversationIfCurrent("discord", "channel", "old", "2026-09-09T00:02:00.000Z"));
    await store.ingestInputEvent({ event: event("new", "channel", "2026-09-09T00:03:00.000Z"), actorPrincipalId: "owner", newConversationId: "new", newTurnId: "new-turn", newRunId: "new-run", createdAt: "2026-09-09T00:03:00.000Z" });
    assert.equal(await store.archiveBoundConversationIfCurrent("discord", "channel", "old", "2026-09-09T00:04:00.000Z"), undefined);
    assert.equal((await store.getConversation("new"))?.state, "active");
  } finally { store.close(); }
});
