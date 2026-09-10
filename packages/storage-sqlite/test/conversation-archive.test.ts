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
    assert.equal((await store.archiveBoundConversation("discord", "channel", "2026-09-09T00:01:00.000Z"))?.state, "archived");
    assert.equal((await store.listTurns("c1")).length, 1);
    const second = await store.ingestInputEvent({ event: event("e2"), actorPrincipalId: "owner", newConversationId: "c2", newTurnId: "t2", newRunId: "r2", createdAt: "2026-09-09T00:02:00.000Z" });
    assert.equal(second.conversationCreated, true);
    assert.equal(second.conversation.id, "c2");
    assert.equal((await store.getConversation("c1"))?.state, "archived");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("session model and queue preferences survive conversation archive", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  try {
    const first = await store.updateConversationPreferences({ transport: "discord", externalId: "channel", expectedRevision: 0, model: "model-a", reasoningEffort: "high", queueMode: "steer", updatedAt: "2026-09-09T00:00:00.000Z" });
    assert.equal(first.revision, 1);
    await store.ingestInputEvent({ event: event("e1"), actorPrincipalId: "owner", newConversationId: "c1", newTurnId: "t1", newRunId: "r1", createdAt: "2026-09-09T00:00:00.000Z" });
    await store.archiveBoundConversation("discord", "channel", "2026-09-09T00:01:00.000Z");
    assert.deepEqual(await store.getConversationPreferences("discord", "channel"), first);
    const second = await store.updateConversationPreferences({ transport: "discord", externalId: "channel", expectedRevision: 1, queueMode: "followup", updatedAt: "2026-09-09T00:02:00.000Z" });
    assert.deepEqual(second, { transport: "discord", externalId: "channel", revision: 2, queueMode: "followup", updatedAt: "2026-09-09T00:02:00.000Z" });
  } finally { store.close(); }
});
