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

export class DurableScheduler implements SchedulerControl {
  private timer: NodeJS.Timeout | undefined; private running = false; private dispatcher: Dispatcher | undefined;
  constructor(private readonly store: SchedulerStore, private readonly intervalMs = 1000, private readonly now: () => Date = () => new Date()) {}
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
  async syncPluginJobs(jobs: readonly PluginJobDefinition[]): Promise<void> {
    const current = new Map((await this.store.listScheduledTriggers()).map(trigger => [trigger.id, trigger]));
    for (const job of jobs) {
      const id = `plugin-job:${job.id}`; if (current.has(id)) continue; const now = this.now(); const schedule = { kind: "cron" as const, expression: job.schedule };
      await this.store.createScheduledTrigger({ id, name: job.id, enabled: true, schedule, timezone: job.timezone ?? "UTC", jobRef: `plugin:${job.id}`, input: {}, creatorPrincipalId: "system", creatorRoles: ["system"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, misfirePolicy: job.misfirePolicy ?? "coalesce", maxAttempts: job.maxAttempts ?? 3, retryBackoffMs: job.retryBackoffMs ?? 15_000, nextFireAt: nextFire(schedule, job.timezone ?? "UTC", now), createdAt: now.toISOString() });
    }
  }
  recover(): Promise<number> { return this.store.recoverScheduledOccurrences(this.now().toISOString()); }
  start(): void { if (this.timer) return; void this.tick(); this.timer = setInterval(() => void this.tick(), this.intervalMs); this.timer.unref(); }
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
