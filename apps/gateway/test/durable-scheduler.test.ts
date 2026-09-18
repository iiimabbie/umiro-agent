import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { reconcilePluginSchedules, DurableScheduler } from "../src/durable-scheduler.js";

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
  const trigger = await scheduler.create({ name: "daily", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "Europe/London", jobRef: "agent.prompt", input: { prompt: "hello" }, creatorPrincipalId: "owner", creatorRoles: ["owner"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 1000 });
  assert.equal(trigger.nextFireAt, "2026-01-01T09:00:00.000Z");
  store.close();
});

test("background scheduler failures are contained and later ticks continue", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const errors: unknown[] = [];
  const scheduler = new DurableScheduler(store, 5, () => new Date(), error => errors.push(error));
  let ticks = 0;
  scheduler.tick = async () => { ticks++; throw new Error("race"); };
  scheduler.start();
  await new Promise(resolve => setTimeout(resolve, 16));
  scheduler.stop();
  assert.ok(ticks >= 2);
  assert.equal(errors.length, ticks);
  store.close();
});

test("schedule update uses the same trigger identity and increments revision", async () => {
  const store = new SQLiteExecutionStore(":memory:"); const scheduler = new DurableScheduler(store, 1000, () => new Date("2026-01-01T00:00:00.000Z"));
  const trigger = await scheduler.create({ name: "daily", enabled: true, schedule: { kind: "cron", expression: "0 9 * * *" }, timezone: "Europe/London", jobRef: "agent.prompt", input: { prompt: "old" }, creatorPrincipalId: "owner", creatorRoles: ["owner"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 1000 });
  const updated = await scheduler.update(trigger.id, { name: "updated", schedule: { kind: "cron", expression: "0 10 * * *" }, timezone: "Europe/London", input: { prompt: "new" }, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 1000 });
  assert.equal(updated.id, trigger.id); assert.equal(updated.revision, 1); assert.equal(updated.name, "updated"); assert.deepEqual(updated.input, { prompt: "new" });
  await assert.rejects(store.updateScheduledTrigger(trigger.id, { name: "stale", schedule: updated.schedule, timezone: updated.timezone, input: updated.input, misfirePolicy: updated.misfirePolicy, maxAttempts: updated.maxAttempts, retryBackoffMs: updated.retryBackoffMs }, 0, updated.nextFireAt, updated.updatedAt), /changed/);
  store.close();
});

test("plugin job sync reconciles changed declarations without re-enabling a disabled trigger", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new SQLiteExecutionStore(":memory:");
  const scheduler = new DurableScheduler(store, 1000, () => now);
  const run = async () => undefined;
  await scheduler.syncPluginJobs([{ id: "guardian.check", schedule: "0 8,20 * * *", timezone: "Europe/London", run }]);
  const created = await store.getScheduledTrigger("plugin-job:guardian.check");
  assert.equal(created?.nextFireAt, "2026-01-01T08:00:00.000Z");
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

test("Plugin-owned schedules are preserved, lifecycle-disabled, restored, or removed by owner state", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const scheduler = new DurableScheduler(store, 1000, () => new Date("2026-09-18T00:00:00Z"));
  const authority = { capabilities: [], visibility: { kind: "all" as const }, instructionAuthority: "full" as const };
  const create = (pluginId: string) => scheduler.create({ name: pluginId, enabled: true, schedule: { kind: "cron" as const, expression: "0 1 * * *" }, timezone: "UTC", jobRef: "agent.prompt", input: { pluginId, prompt: "work" }, creatorPrincipalId: "owner", creatorRoles: ["owner"], authority, misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 1000 });
  const kept = await create("diary"); const disabled = await create("weather"); const orphan = await create("removed-plugin");
  const result = await reconcilePluginSchedules(scheduler, new Map([["diary", "enabled"], ["weather", "disabled"]]), new Map());
  assert.deepEqual(result, { disabled: 1, enabled: 0, removed: 1 });
  let current = new Map((await scheduler.list()).map(trigger => [trigger.id, trigger]));
  assert.equal(current.get(kept.id)?.enabled, true);
  assert.equal(current.get(disabled.id)?.enabled, false);
  assert.equal(current.get(disabled.id)?.input._umiroPluginLifecycleDisabled, true);
  assert.equal(current.has(orphan.id), false);
  assert.deepEqual(await reconcilePluginSchedules(scheduler, new Map([["diary", "enabled"], ["weather", "enabled"]]), new Map()), { disabled: 0, enabled: 1, removed: 0 });
  current = new Map((await scheduler.list()).map(trigger => [trigger.id, trigger]));
  assert.equal(current.get(disabled.id)?.enabled, true);
  assert.equal(current.get(disabled.id)?.input._umiroPluginLifecycleDisabled, undefined);
  store.close();
});

test("Plugin job schedules use the same three-state lifecycle without re-enabling manual disables", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const scheduler = new DurableScheduler(store, 1000, () => new Date("2026-09-18T00:00:00Z"));
  await scheduler.syncPluginJobs([{ id: "guardian.check", schedule: "0 1 * * *", async run() {} }], new Map([["guardian.check", "guardian"]]));
  const trigger = (await scheduler.list())[0]!;
  assert.equal(trigger.input.pluginId, "guardian");
  await scheduler.setEnabled(trigger.id, false);
  await reconcilePluginSchedules(scheduler, new Map([["guardian", "enabled"]]), new Map([["guardian.check", "enabled"]]));
  assert.equal((await scheduler.list())[0]?.enabled, false);
  await reconcilePluginSchedules(scheduler, new Map([["guardian", "disabled"]]), new Map([["guardian.check", "disabled"]]));
  await reconcilePluginSchedules(scheduler, new Map([["guardian", "enabled"]]), new Map([["guardian.check", "enabled"]]));
  assert.equal((await scheduler.list())[0]?.enabled, true);
  store.close();
});
