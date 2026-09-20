import type { ArchiveActiveConversationsResult, ConversationStore, ScheduledOccurrence, SchedulerControl } from "@umiro/core";

export interface ConversationAutoArchiveConfig {
  readonly enabled: boolean;
  readonly time: string;
  readonly timezone: string;
}

export const CONVERSATION_AUTO_ARCHIVE_JOB_REF = "system:conversation-auto-archive";
export const CONVERSATION_AUTO_ARCHIVE_IDEMPOTENCY_KEY = "core.conversation-auto-archive";

const DEFAULT_TIME = "00:00";
const DEFAULT_TIMEZONE = "UTC";
const scheduleId = `tool:${CONVERSATION_AUTO_ARCHIVE_IDEMPOTENCY_KEY}`;

export function systemTimezone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
}

export function parseConversationAutoArchiveConfig(value: unknown): ConversationAutoArchiveConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const auto = raw.autoArchive && typeof raw.autoArchive === "object" && !Array.isArray(raw.autoArchive) ? raw.autoArchive as Record<string, unknown> : {};
  const time = auto.time === undefined ? DEFAULT_TIME : auto.time;
  const timezone = auto.timezone === undefined ? systemTimezone() : auto.timezone;
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new TypeError("conversation.autoArchive.time must use HH:mm");
  if (typeof timezone !== "string" || !timezone.trim()) throw new TypeError("conversation.autoArchive.timezone must be an IANA timezone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); } catch { throw new TypeError(`invalid IANA timezone: ${timezone}`); }
  if (auto.enabled !== undefined && typeof auto.enabled !== "boolean") throw new TypeError("conversation.autoArchive.enabled must be boolean");
  return { enabled: auto.enabled === true, time, timezone };
}

export function conversationAutoArchiveCron(time: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new TypeError("conversation auto archive time must use HH:mm");
  const [hour, minute] = time.split(":");
  return `${Number(minute)} ${Number(hour)} * * *`;
}

const triggerPatch = (config: ConversationAutoArchiveConfig) => ({
  name: "Conversation auto archive",
  schedule: { kind: "cron" as const, expression: conversationAutoArchiveCron(config.time) },
  timezone: config.timezone,
  input: {},
  misfirePolicy: "coalesce" as const,
  maxAttempts: 3,
  retryBackoffMs: 15_000,
});

/** Reconcile one stable, system-owned trigger without touching user schedules. */
export async function syncConversationAutoArchiveSchedule(scheduler: SchedulerControl, config: ConversationAutoArchiveConfig): Promise<void> {
  const existing = (await scheduler.list()).find(trigger => trigger.id === scheduleId || trigger.jobRef === CONVERSATION_AUTO_ARCHIVE_JOB_REF);
  if (!existing) {
    if (!config.enabled) return;
    await scheduler.create({ ...triggerPatch(config), enabled: true, jobRef: CONVERSATION_AUTO_ARCHIVE_JOB_REF, creatorPrincipalId: "system", creatorRoles: ["system"], authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" } }, CONVERSATION_AUTO_ARCHIVE_IDEMPOTENCY_KEY);
    return;
  }
  const patch = triggerPatch(config);
  const changed = existing.name !== patch.name || existing.timezone !== patch.timezone || existing.schedule.kind !== "cron" || existing.schedule.expression !== patch.schedule.expression || existing.misfirePolicy !== patch.misfirePolicy || existing.maxAttempts !== patch.maxAttempts || existing.retryBackoffMs !== patch.retryBackoffMs || JSON.stringify(existing.input) !== "{}";
  try {
    if (changed) await scheduler.update(existing.id, patch);
    if (existing.enabled !== config.enabled) await scheduler.setEnabled(existing.id, config.enabled);
  } catch (error) {
    // A control-panel apply must not leave a partially reconciled trigger behind.
    try {
      const current = (await scheduler.list()).find(trigger => trigger.id === existing.id);
      if (current) {
        await scheduler.update(current.id, { name: existing.name, schedule: existing.schedule, timezone: existing.timezone, input: existing.input, ...(existing.destination ? { destination: existing.destination } : {}), misfirePolicy: existing.misfirePolicy, maxAttempts: existing.maxAttempts, retryBackoffMs: existing.retryBackoffMs });
        if (current.enabled !== existing.enabled) await scheduler.setEnabled(current.id, existing.enabled);
      }
    } catch { /* startup reconciliation will retry the durable snapshot */ }
    throw error;
  }
}

export class ConversationAutoArchiveCoordinator {
  private readonly pending = new Map<string, { readonly cutoff: string; readonly conversationId: string }>();
  private readonly retries = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  constructor(private readonly store: ConversationStore, private readonly activeScopes: () => readonly string[], private readonly log: (event: string, data: Record<string, unknown>) => void = () => undefined) {}

  async run(occurrence: ScheduledOccurrence, signal?: AbortSignal): Promise<ArchiveActiveConversationsResult> {
    if (signal?.aborted) throw signal.reason ?? new Error("conversation auto archive aborted");
    const cutoff = occurrence.scheduledFor;
    const excluded = [...new Set(this.activeScopes())];
    const result = await this.store.archiveActiveConversationsBefore({ transport: "discord", cutoff, archivedAt: new Date().toISOString(), excludeExternalIds: excluded });
    for (const skipped of result.skipped) { this.pending.set(skipped.externalId, { cutoff, conversationId: skipped.conversationId }); this.retries.delete(skipped.externalId); }
    this.log("conversation.auto_archive.completed", { cutoff, archivedCount: result.archived.length, deferredCount: result.skipped.length });
    return result;
  }

  async onScopeIdle(externalId: string): Promise<boolean> {
    const pending = this.pending.get(externalId);
    if (!pending) return false;
    try {
      const archived = await this.store.archiveBoundConversationIfCurrent("discord", externalId, pending.conversationId, new Date().toISOString());
      this.pending.delete(externalId);
      this.retries.delete(externalId);
      const retryTimer = this.retryTimers.get(externalId); if (retryTimer) clearTimeout(retryTimer); this.retryTimers.delete(externalId);
      this.log("conversation.auto_archive.deferred_completed", { externalId, cutoff: pending.cutoff, conversationId: pending.conversationId, archived: Boolean(archived) });
      return Boolean(archived);
    } catch (error) {
      this.log("conversation.auto_archive.deferred_failed", { externalId, cutoff: pending.cutoff, conversationId: pending.conversationId, errorName: error instanceof Error ? error.name : "NonErrorThrown" });
      const attempts = (this.retries.get(externalId) ?? 0) + 1;
      this.retries.set(externalId, attempts);
      if (attempts <= 3 && !this.retryTimers.has(externalId)) {
        const timer = setTimeout(() => { this.retryTimers.delete(externalId); void this.onScopeIdle(externalId); }, 1_000 * 2 ** (attempts - 1));
        timer.unref?.();
        this.retryTimers.set(externalId, timer);
      }
      return false;
    }
  }

  clear(): void { this.pending.clear(); this.retries.clear(); for (const timer of this.retryTimers.values()) clearTimeout(timer); this.retryTimers.clear(); }
}
