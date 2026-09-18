import { Cron } from "croner";
import type { JsonObject } from "@umiro/core/ports";
import type { CreateScheduledTrigger, ScheduledOccurrence, ScheduledTrigger, SchedulerControl, SchedulerStore, TriggerSchedule } from "@umiro/core/scheduler";
import type { PluginJobDefinition } from "@umiro/core/plugin";

type Dispatcher = (trigger: ScheduledTrigger, occurrence: ScheduledOccurrence, signal?: AbortSignal) => Promise<void>;

function nextFire(schedule: TriggerSchedule, timezone: string, after: Date): string | null {
  if (schedule.kind === "once") { const date = new Date(schedule.at); if (!Number.isFinite(date.getTime())) throw new TypeError(`invalid one-shot timestamp: ${schedule.at}`); return date.toISOString(); }
  const cron = new Cron(schedule.expression, { timezone, paused: true });
  try { return cron.nextRun(after)?.toISOString() ?? null; } finally { cron.stop(); }
}

export function previewNextFire(schedule: TriggerSchedule, timezone: string, after = new Date()): string | null { return nextFire(schedule, timezone, after); }

export type PluginRuntimeState = "enabled" | "disabled";
export interface PluginScheduleReconciliation { readonly disabled: number; readonly enabled: number; readonly removed: number }
const LIFECYCLE_DISABLED = "_umiroPluginLifecycleDisabled";

function schedulePatch(trigger: ScheduledTrigger, input: JsonObject) {
  return { name: trigger.name, schedule: trigger.schedule, timezone: trigger.timezone, input, ...(trigger.destination ? { destination: trigger.destination } : {}), misfirePolicy: trigger.misfirePolicy, maxAttempts: trigger.maxAttempts, retryBackoffMs: trigger.retryBackoffMs };
}

/** Reconcile all durable schedules owned by Plugins without touching user-owned schedules. */
export async function reconcilePluginSchedules(scheduler: SchedulerControl, pluginStates: ReadonlyMap<string, PluginRuntimeState>, pluginJobStates: ReadonlyMap<string, PluginRuntimeState>): Promise<PluginScheduleReconciliation> {
  let disabled = 0; let enabled = 0; let removed = 0;
  for (const trigger of await scheduler.list()) {
    const promptPluginId = trigger.jobRef === "agent.prompt" && typeof trigger.input.pluginId === "string" ? trigger.input.pluginId : undefined;
    const jobId = trigger.jobRef.startsWith("plugin:") ? trigger.jobRef.slice("plugin:".length) : undefined;
    const state = promptPluginId ? pluginStates.get(promptPluginId) : jobId ? pluginJobStates.get(jobId) : undefined;
    if (!promptPluginId && !jobId) continue;
    if (!state) { if (await scheduler.remove(trigger.id)) removed += 1; continue; }
    if (state === "disabled") {
      if (scheduler.update && trigger.input[LIFECYCLE_DISABLED] !== true) await scheduler.update(trigger.id, schedulePatch(trigger, { ...trigger.input, [LIFECYCLE_DISABLED]: true }));
      if (trigger.enabled) { await scheduler.setEnabled(trigger.id, false); disabled += 1; }
      continue;
    }
    if (trigger.input[LIFECYCLE_DISABLED] === true) {
      if (scheduler.update) { const input = { ...trigger.input }; delete input[LIFECYCLE_DISABLED]; await scheduler.update(trigger.id, schedulePatch(trigger, input)); }
      if (!trigger.enabled) { await scheduler.setEnabled(trigger.id, true); enabled += 1; }
    }
  }
  return { disabled, enabled, removed };
}

export class DurableScheduler implements SchedulerControl {
  private timer: NodeJS.Timeout | undefined; private running = false; private dispatcher: Dispatcher | undefined;
  constructor(private readonly store: SchedulerStore, private readonly intervalMs = 1000, private readonly now: () => Date = () => new Date(), private readonly onBackgroundError: (error: unknown) => void = () => undefined) {}
  setDispatcher(dispatcher: Dispatcher): void { this.dispatcher = dispatcher; }
  async create(input: Omit<CreateScheduledTrigger, "id" | "nextFireAt" | "createdAt">, idempotencyKey?: string): Promise<ScheduledTrigger> {
    const now = this.now();
    const id = idempotencyKey ? `tool:${idempotencyKey}` : crypto.randomUUID(); const existing = await this.store.getScheduledTrigger(id); if (existing) return existing;
    return this.store.createScheduledTrigger({ ...input, id, nextFireAt: input.enabled ? nextFire(input.schedule, input.timezone, now) : null, createdAt: now.toISOString() });
  }
  list(): Promise<readonly ScheduledTrigger[]> { return this.store.listScheduledTriggers(); }
  async setEnabled(id: string, enabled: boolean): Promise<ScheduledTrigger> { const trigger = await this.store.getScheduledTrigger(id); if (!trigger) throw new Error(`scheduled trigger not found: ${id}`); return this.store.setScheduledTriggerEnabled(id, enabled, enabled ? nextFire(trigger.schedule, trigger.timezone, this.now()) : null, trigger.revision, this.now().toISOString()); }
  async update(id: string, patch: Parameters<NonNullable<SchedulerControl["update"]>>[1]): Promise<ScheduledTrigger> { const trigger = await this.store.getScheduledTrigger(id); if (!trigger) throw new Error(`scheduled trigger not found: ${id}`); return this.store.updateScheduledTrigger(id, patch, trigger.revision, trigger.enabled ? nextFire(patch.schedule, patch.timezone, this.now()) : null, this.now().toISOString()); }
  remove(id: string): Promise<boolean> { return this.store.deleteScheduledTrigger(id); }
  async syncPluginJobs(jobs: readonly PluginJobDefinition[], pluginIds: ReadonlyMap<string, string> = new Map()): Promise<void> {
    const current = new Map((await this.store.listScheduledTriggers()).map(trigger => [trigger.id, trigger]));
    for (const job of jobs) {
      const id = `plugin-job:${job.id}`; const now = this.now(); const schedule = { kind: "cron" as const, expression: job.schedule };
      const patch = { name: job.id, schedule, timezone: job.timezone ?? "UTC", input: pluginIds.has(job.id) ? { pluginId: pluginIds.get(job.id)! } : {}, misfirePolicy: job.misfirePolicy ?? "coalesce", maxAttempts: job.maxAttempts ?? 3, retryBackoffMs: job.retryBackoffMs ?? 15_000 };
      const existing = current.get(id);
      if (!existing) {
        await this.store.createScheduledTrigger({ id, ...patch, enabled: true, jobRef: `plugin:${job.id}`, creatorPrincipalId: "system", creatorRoles: ["system"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, nextFireAt: nextFire(schedule, patch.timezone, now), createdAt: now.toISOString() });
        continue;
      }
      const changed = existing.name !== patch.name
        || existing.schedule.kind !== "cron"
        || existing.schedule.expression !== patch.schedule.expression
        || existing.timezone !== patch.timezone
        || JSON.stringify(existing.input) !== JSON.stringify(patch.input)
        || existing.destination !== undefined
        || existing.misfirePolicy !== patch.misfirePolicy
        || existing.maxAttempts !== patch.maxAttempts
        || existing.retryBackoffMs !== patch.retryBackoffMs;
      if (changed) await this.store.updateScheduledTrigger(id, patch, existing.revision, existing.enabled ? nextFire(schedule, patch.timezone, now) : null, now.toISOString());
    }
  }
  recover(): Promise<number> { return this.store.recoverScheduledOccurrences(this.now().toISOString()); }
  start(): void {
    if (this.timer) return;
    const run = () => { void this.tick().catch(error => this.onBackgroundError(error)); };
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick(signal?: AbortSignal): Promise<void> {
    if (this.running || !this.dispatcher) return; this.running = true;
    try {
      const now = this.now();
      for (const retry of await this.store.listRetryableScheduledOccurrences(now.toISOString(), 20)) {
        const claimed = await this.store.claimScheduledRetry(retry.id, retry.attempts, crypto.randomUUID(), now.toISOString()); if (!claimed) continue;
        const trigger = await this.store.getScheduledTrigger(claimed.triggerId); if (trigger) await this.execute(trigger, claimed, signal);
      }
      for (const trigger of await this.store.listDueScheduledTriggers(now.toISOString(), 20)) {
        const scheduledFor = trigger.nextFireAt!;
        const base = trigger.misfirePolicy === "catch_up" ? new Date(scheduledFor) : now;
        const following = trigger.schedule.kind === "once" ? null : nextFire(trigger.schedule, trigger.timezone, base);
        const occurrence = await this.store.claimScheduledOccurrence(trigger.id, trigger.revision, scheduledFor, following, trigger.schedule.kind === "once", `${trigger.id}:${scheduledFor}`, crypto.randomUUID(), now.toISOString());
        if (!occurrence) continue;
        const skipped = trigger.misfirePolicy === "skip" && trigger.schedule.kind === "cron" && nextFire(trigger.schedule, trigger.timezone, new Date(scheduledFor))! <= now.toISOString();
        if (skipped) await this.store.completeScheduledOccurrence(occurrence.id, now.toISOString()); else await this.execute(trigger, occurrence, signal);
      }
    } finally { this.running = false; }
  }
  private async execute(trigger: ScheduledTrigger, occurrence: ScheduledOccurrence, signal?: AbortSignal): Promise<void> {
    try { await this.dispatcher!(trigger, occurrence, signal); await this.store.completeScheduledOccurrence(occurrence.id, this.now().toISOString()); }
    catch (error) { const retry = occurrence.attempts < trigger.maxAttempts ? new Date(this.now().getTime() + trigger.retryBackoffMs * 2 ** (occurrence.attempts - 1)).toISOString() : undefined; await this.store.failScheduledOccurrence(occurrence.id, error instanceof Error ? error.message : String(error), retry, this.now().toISOString()); }
  }
}
