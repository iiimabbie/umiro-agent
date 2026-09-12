import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilities, type Run, type Step } from "@umiro/core";
import Database from "better-sqlite3";
import { SQLiteExecutionStore } from "../src/index.js";
import { CONVERSATION_LOCATIONS_SCHEMA } from "../src/migrations/026-conversation-locations.js";

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
    assert.deepEqual((await store.listConversations({ state: "archived" })).map(item => [item.conversation.id, item.location.externalId, item.turnCount, item.firstText]), [["c1", "channel", 1, "e1"]]);
    assert.deepEqual((await store.listConversations({ transport: "discord", externalId: "channel", state: "active" })).map(item => item.conversation.id), ["c2"]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("conversation message pages preserve sequence, observations, replies, and bounded output", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const context = (conversationId: string) => ({ actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, origin: { kind: "interactive" as const, transport: "discord", conversationId }, authority: { capabilities: capabilities(), visibility: { kind: "all" as const }, instructionAuthority: "full" as const } });
  const run = (id: string, turnId: string): Run => ({ id, revision: 0, state: "queued", context: context("thread-conversation"), conversationId: "thread-conversation", turnId, resumeEligibility: "not_applicable", createdAt: "2026-09-09T00:01:00.000Z", updatedAt: "2026-09-09T00:01:00.000Z" });
  const step = (id: string, runId: string): Step => ({ id, runId, revision: 0, sequence: 0, kind: "model_call", state: "pending", createdAt: "2026-09-09T00:01:00.000Z", updatedAt: "2026-09-09T00:01:00.000Z" });
  try {
    await store.findOrCreate({ transport: "discord", externalId: "owner-user", principalId: "owner", displayName: "iiimabbie" }, "2026-09-09T00:00:00.000Z");
    const threadEvent = (id: string, text: string, user = "owner-user") => ({ ...event(id), identity: { transport: "discord", externalId: user, principalId: null }, conversation: { transport: "discord", externalId: "thread-1", kind: "thread" as const }, content: [{ type: "text" as const, text }] });
    await store.ingestInputEvent({ event: threadEvent("trigger", "幫我看一下這個"), actorPrincipalId: "owner", newConversationId: "thread-conversation", newTurnId: "trigger-turn", newRunId: "success-run", createdAt: "2026-09-09T00:01:00.000Z", initialTurns: [{ id: "starter-turn", actorPrincipalId: "starter", inputEventId: "starter-event", content: [{ type: "text", text: "[System] This is the initial message\n首樓" }], createdAt: "2026-09-09T00:00:00.000Z" }] });
    await store.createRunWithStep(run("success-run", "trigger-turn"), step("success-step", "success-run"));
    await store.updateExecutionProgress({ runId: "success-run", expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: "2026-09-09T00:01:01.000Z" });
    await store.completeRunWithOutput({ output: { id: "success-output", runId: "success-run", text: "好，我看了", usage: { inputTokens: 9, outputTokens: 2, reasoningTokens: 0 }, createdAt: "2026-09-09T00:01:02.000Z" }, delivery: { id: "success-delivery", runId: "success-run", destination: { kind: "discord", channelId: "thread-1" }, payload: { text: "好，我看了" }, state: "pending", createdAt: "2026-09-09T00:01:02.000Z" }, expectedRunRevision: 1, runUpdatedAt: "2026-09-09T00:01:02.000Z" });
    await store.observeInputEvent({ event: threadEvent("observed", "旁邊補充", "member-user"), actorPrincipalId: "member", newConversationId: "unused-observed", newTurnId: "observed-turn", createdAt: "2026-09-09T00:02:00.000Z" });
    await store.ingestInputEvent({ event: threadEvent("failed", "再試一次"), actorPrincipalId: "owner", newConversationId: "unused-triggered", newTurnId: "failed-turn", newRunId: "failed-run", createdAt: "2026-09-09T00:03:00.000Z" });
    await store.createRunWithStep(run("failed-run", "failed-turn"), step("failed-step", "failed-run"));
    await store.updateExecutionProgress({ runId: "failed-run", expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: "2026-09-09T00:03:01.000Z" });
    await store.updateExecutionProgress({ runId: "failed-run", expectedRunRevision: 1, expectedRunState: "running", runState: "failed", resumeEligibility: "ineligible", runUpdatedAt: "2026-09-09T00:03:02.000Z" });

    const summaries = await store.listConversations({ transport: "discord", externalId: "thread-1", state: "active" });
    assert.equal(summaries[0]?.firstText, "幫我看一下這個");
    assert.equal(summaries[0]?.turnCount, 4);
    const first = await store.listConversationMessages("thread-conversation", 2);
    assert.deepEqual(first?.messages.map(item => item.turn.sequence), [0, 1]);
    assert.equal(first?.hasMore, true);
    assert.deepEqual(first?.messages[1]?.reply, { runId: "success-run", state: "succeeded", at: "2026-09-09T00:01:02.000Z", text: "好，我看了", usage: { inputTokens: 9, outputTokens: 2, reasoningTokens: 0 } });
    assert.equal(first?.messages[1]?.actorDisplayName, "iiimabbie");
    const second = await store.listConversationMessages("thread-conversation", 2, 1);
    assert.deepEqual(second?.messages.map(item => item.turn.sequence), [2, 3]);
    assert.equal(second?.hasMore, false);
    assert.equal(second?.messages[0]?.reply, undefined);
    assert.deepEqual(second?.messages[1]?.reply, { runId: "failed-run", state: "failed", at: "2026-09-09T00:03:02.000Z" });
    assert.equal(await store.listConversationMessages("missing"), undefined);
  } finally { store.close(); }
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
    assert.equal(await store.hasConversationScope("discord", "channel"), true);
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

test("schema 26 backfills an archived Conversation location from its Discord delivery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "umiro-location-migration-"));
  const filename = join(directory, "db.sqlite");
  let store = new SQLiteExecutionStore(filename);
  const execution = { actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, origin: { kind: "interactive" as const, transport: "discord", conversationId: "c1" }, authority: { capabilities: capabilities(), visibility: { kind: "all" as const }, instructionAuthority: "full" as const } };
  try {
    await store.ingestInputEvent({ event: event("old"), actorPrincipalId: "owner", newConversationId: "c1", newTurnId: "t1", newRunId: "r1", createdAt: "2026-09-09T00:00:00.000Z" });
    await store.createRunWithStep({ id: "r1", revision: 0, state: "queued", context: execution, conversationId: "c1", turnId: "t1", resumeEligibility: "not_applicable", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" }, { id: "s1", runId: "r1", revision: 0, sequence: 0, kind: "model_call", state: "pending", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" });
    await store.updateExecutionProgress({ runId: "r1", expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: "2026-09-09T00:00:01.000Z" });
    await store.completeRunWithOutput({ output: { id: "o1", runId: "r1", text: "done", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, createdAt: "2026-09-09T00:00:02.000Z" }, delivery: { id: "d1", runId: "r1", destination: { kind: "discord", channelId: "channel" }, payload: { text: "done" }, state: "pending", createdAt: "2026-09-09T00:00:02.000Z" }, expectedRunRevision: 1, runUpdatedAt: "2026-09-09T00:00:02.000Z" });
    await store.archiveBoundConversation("discord", "channel", "2026-09-09T00:01:00.000Z");
    await store.ingestInputEvent({ event: event("new"), actorPrincipalId: "owner", newConversationId: "c2", newTurnId: "t2", newRunId: "r2", createdAt: "2026-09-09T00:02:00.000Z" });
    store.close();
    const database = new Database(filename);
    database.exec("DROP TABLE conversation_locations;");
    database.exec(CONVERSATION_LOCATIONS_SCHEMA);
    database.close();
    store = new SQLiteExecutionStore(filename);
    const archived = await store.listConversations({ state: "archived" });
    assert.deepEqual(archived.map(item => [item.conversation.id, item.location.transport, item.location.externalId, item.location.kind]), [["c1", "discord", "channel", "channel"]]);
  } finally { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); }
});
