import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationStore, InputEvent, ScheduledOccurrence, ScheduledTrigger, SchedulerControl } from "@umiro/core";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { DurableScheduler } from "../src/durable-scheduler.js";
import { ConversationAutoArchiveCoordinator, conversationAutoArchiveCron, parseConversationAutoArchiveConfig, syncConversationAutoArchiveSchedule, CONVERSATION_AUTO_ARCHIVE_JOB_REF } from "../src/conversation-auto-archive.js";

const trigger = (enabled = true): ScheduledTrigger => ({ id: "tool:core.conversation-auto-archive", revision: 0, name: "Conversation auto archive", enabled, schedule: { kind: "cron", expression: "0 0 * * *" }, timezone: "UTC", jobRef: CONVERSATION_AUTO_ARCHIVE_JOB_REF, input: {}, creatorPrincipalId: "system", creatorRoles: ["system"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 15_000, nextFireAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

test("auto archive config and cron are strict", () => {
  assert.equal(conversationAutoArchiveCron("09:05"), "5 9 * * *");
  assert.equal(conversationAutoArchiveCron("23:59"), "59 23 * * *");
  assert.deepEqual(parseConversationAutoArchiveConfig({ autoArchive: { enabled: true, time: "09:05", timezone: "Asia/Taipei" } }), { enabled: true, time: "09:05", timezone: "Asia/Taipei" });
  assert.throws(() => parseConversationAutoArchiveConfig({ autoArchive: { time: "9:05" } }), /HH:mm/);
  assert.throws(() => parseConversationAutoArchiveConfig({ autoArchive: { timezone: "Not/AZone" } }), /invalid IANA/);
});

test("schedule reconciliation is stable and toggles the same durable trigger", async () => {
  let current: ScheduledTrigger | undefined;
  let createCount = 0;
  const scheduler = {
    async list() { return current ? [current] : []; },
    async create(input: Parameters<SchedulerControl["create"]>[0]) { createCount += 1; current = { ...input, id: "tool:core.conversation-auto-archive", revision: 0, nextFireAt: null, createdAt: "now", updatedAt: "now" } as ScheduledTrigger; return current; },
    async update(id: string, patch: Parameters<SchedulerControl["update"]>[1]) { current = { ...current!, ...patch, id, revision: current!.revision + 1 }; return current; },
    async setEnabled(id: string, enabled: boolean) { current = { ...current!, id, enabled }; return current; },
    async remove() { current = undefined; return true; },
  } as SchedulerControl;
  await syncConversationAutoArchiveSchedule(scheduler, { enabled: true, time: "09:05", timezone: "Asia/Taipei" });
  await syncConversationAutoArchiveSchedule(scheduler, { enabled: true, time: "09:05", timezone: "Asia/Taipei" });
  assert.equal(createCount, 1);
  assert.equal(current?.schedule.kind === "cron" ? current.schedule.expression : "", "5 9 * * *");
  await syncConversationAutoArchiveSchedule(scheduler, { enabled: false, time: "09:05", timezone: "Asia/Taipei" });
  assert.equal(current?.enabled, false);
});

test("active scopes are deferred and use the original cutoff when idle", async () => {
  const calls: unknown[] = [];
  const store = {
    archiveActiveConversationsBefore: async (input: unknown) => { calls.push(input); return { archived: [], skipped: [{ conversationId: "c", externalId: "channel" }] }; },
    archiveBoundConversationIfCurrent: async (...input: unknown[]) => { calls.push(input); return { id: "c" }; },
  } as unknown as ConversationStore;
  const coordinator = new ConversationAutoArchiveCoordinator(store, () => ["channel"]);
  const occurrence = { id: "o", triggerId: "t", scheduledFor: "2026-09-10T00:00:00.000Z", status: "running", attempts: 1, runId: "r", claimedAt: "2026-09-10T00:01:00.000Z" } as ScheduledOccurrence;
  await coordinator.run(occurrence);
  await coordinator.onScopeIdle("channel");
  assert.equal(calls.length, 2);
  assert.equal((calls[0] as { cutoff: string }).cutoff, "2026-09-10T00:00:00.000Z");
  assert.deepEqual((calls[1] as unknown[]).slice(0, 3), ["discord", "channel", "c"]);
});

test("only eligible excluded conversations become pending", async () => {
  let conditionalCalls = 0;
  const store = {
    archiveActiveConversationsBefore: async () => ({ archived: [], skipped: [] }),
    archiveBoundConversationIfCurrent: async () => { conditionalCalls += 1; return undefined; },
  } as unknown as ConversationStore;
  const coordinator = new ConversationAutoArchiveCoordinator(store, () => ["newer-channel"]);
  await coordinator.run({ scheduledFor: "2026-09-10T00:00:00.000Z" } as ScheduledOccurrence);
  assert.equal(await coordinator.onScopeIdle("newer-channel"), false);
  assert.equal(conditionalCalls, 0);
});

test("a due durable trigger archives an eligible bound conversation end to end", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  let now = new Date("2026-09-09T23:59:00.000Z");
  const scheduler = new DurableScheduler(store, 1_000, () => now);
  const coordinator = new ConversationAutoArchiveCoordinator(store, () => []);
  const event: InputEvent = { id: "event", occurredAt: "2026-09-09T23:58:00.000Z", identity: { transport: "discord", externalId: "owner", principalId: null }, conversation: { transport: "discord", externalId: "channel", kind: "channel" }, content: [{ type: "text", text: "before midnight" }] };
  try {
    await store.ingestInputEvent({ event, actorPrincipalId: "owner", newConversationId: "conversation", newTurnId: "turn", newRunId: "run", createdAt: event.occurredAt });
    await syncConversationAutoArchiveSchedule(scheduler, { enabled: true, time: "00:00", timezone: "UTC" });
    scheduler.setDispatcher(async (scheduled, occurrence, signal) => {
      assert.equal(scheduled.jobRef, CONVERSATION_AUTO_ARCHIVE_JOB_REF);
      await coordinator.run(occurrence, signal);
    });
    now = new Date("2026-09-10T00:00:00.000Z");
    await scheduler.tick();
    assert.equal((await store.getConversation("conversation"))?.state, "archived");
    assert.deepEqual(await store.listConversationBindings("discord"), []);
  } finally { coordinator.clear(); store.close(); }
});
