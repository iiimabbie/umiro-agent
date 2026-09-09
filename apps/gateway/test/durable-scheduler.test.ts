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
