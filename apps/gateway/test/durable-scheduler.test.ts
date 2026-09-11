import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { DurableScheduler } from "../src/durable-scheduler.js";

test("durable one-shot scheduling deduplicates occurrence and records a new Run per retry", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new SQLiteExecutionStore(":memory:");
  const scheduler = new DurableScheduler(store, 1000, () => now);
  const trigger = await scheduler.create({ name: "remind", enabled: true, schedule: { kind: "once", at: "2025-12-31T23:59:00.000Z" }, timezone: "UTC", jobRef: "agent.prompt", input: { prompt: "hello" }, creatorPrincipalId: "owner", creatorRoles: ["owner"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, misfirePolicy: "coalesce", maxAttempts: 2, retryBackoffMs: 1000 }, "stable");
  const runs: string[] = [];
  scheduler.setDispatcher(async (_trigger, occurrence) => { runs.push(occurrence.runId); if (runs.length === 1) throw new Error("temporary"); });
  await scheduler.tick();
  const occurrenceId = `${trigger.id}:2025-12-31T23:59:00.000Z`;
  const failed = await store.getScheduledOccurrence(occurrenceId);
  assert.equal(failed?.status, "failed"); assert.equal((await store.getScheduledTrigger(trigger.id))?.enabled, false);
  now = new Date("2026-01-01T00:00:02.000Z"); await scheduler.tick();
  const completed = await store.getScheduledOccurrence(occurrenceId);
  assert.equal(completed?.status, "succeeded"); assert.equal(completed?.attempts, 2); assert.equal(runs.length, 2); assert.notEqual(runs[0], runs[1]); assert.equal(runs[1], completed?.runId);
  store.close();
});

test("cron schedules validate timezone and calculate the next durable fire", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const scheduler = new DurableScheduler(store, 1000, () => new Date("2026-01-01T00:00:00.000Z"));
  const trigger = await scheduler.create({ name: "daily", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "Asia/Taipei", jobRef: "agent.prompt", input: { prompt: "hello" }, creatorPrincipalId: "owner", creatorRoles: ["owner"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 1000 });
  assert.equal(trigger.nextFireAt, "2026-01-01T01:00:00.000Z");
  store.close();
});

test("schedule update uses the same trigger identity and increments revision", async () => {
  const store = new SQLiteExecutionStore(":memory:"); const scheduler = new DurableScheduler(store, 1000, () => new Date("2026-01-01T00:00:00.000Z"));
  const trigger = await scheduler.create({ name: "daily", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "Asia/Taipei", jobRef: "agent.prompt", input: { prompt: "old" }, creatorPrincipalId: "owner", creatorRoles: ["owner"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 1000 });
  const updated = await scheduler.update(trigger.id, { name: "updated", schedule: { kind: "cron", expression: "0 10 * * *" }, timezone: "Asia/Taipei", input: { prompt: "new" }, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 1000 });
  assert.equal(updated.id, trigger.id); assert.equal(updated.revision, 1); assert.equal(updated.name, "updated"); assert.deepEqual(updated.input, { prompt: "new" });
  await assert.rejects(store.updateScheduledTrigger(trigger.id, { name: "stale", schedule: updated.schedule, timezone: updated.timezone, input: updated.input, misfirePolicy: updated.misfirePolicy, maxAttempts: updated.maxAttempts, retryBackoffMs: updated.retryBackoffMs }, 0, updated.nextFireAt, updated.updatedAt), /changed/);
  store.close();
});

test("plugin job sync reconciles changed declarations without re-enabling a disabled trigger", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new SQLiteExecutionStore(":memory:");
  const scheduler = new DurableScheduler(store, 1000, () => now);
  const run = async () => undefined;
  await scheduler.syncPluginJobs([{ id: "guardian.check", schedule: "0 8,20 * * *", timezone: "Asia/Taipei", run }]);
  const created = await store.getScheduledTrigger("plugin-job:guardian.check");
  assert.equal(created?.nextFireAt, "2026-01-01T12:00:00.000Z");
  await scheduler.setEnabled("plugin-job:guardian.check", false);

  now = new Date("2026-01-01T00:00:30.000Z");
  await scheduler.syncPluginJobs([{ id: "guardian.check", schedule: "* * * * *", timezone: "UTC", misfirePolicy: "skip", maxAttempts: 5, retryBackoffMs: 2500, run }]);
  const updated = await store.getScheduledTrigger("plugin-job:guardian.check");
  assert.equal(updated?.revision, 2);
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.nextFireAt, null);
  assert.deepEqual(updated?.schedule, { kind: "cron", expression: "* * * * *" });
  assert.equal(updated?.timezone, "UTC");
  assert.equal(updated?.misfirePolicy, "skip");
  assert.equal(updated?.maxAttempts, 5);
  assert.equal(updated?.retryBackoffMs, 2500);

  await scheduler.syncPluginJobs([{ id: "guardian.check", schedule: "* * * * *", timezone: "UTC", misfirePolicy: "skip", maxAttempts: 5, retryBackoffMs: 2500, run }]);
  assert.equal((await store.getScheduledTrigger("plugin-job:guardian.check"))?.revision, 2);
  store.close();
});
