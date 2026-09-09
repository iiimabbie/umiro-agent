import type { Authority } from "../authorization/authority.js";
import type { JsonObject } from "../ports/json.js";

export type TriggerSchedule = { readonly kind: "cron"; readonly expression: string } | { readonly kind: "once"; readonly at: string };
export type MisfirePolicy = "catch_up" | "coalesce" | "skip";
export interface ScheduledTrigger {
  readonly id: string; readonly revision: number; readonly name: string; readonly enabled: boolean;
  readonly schedule: TriggerSchedule; readonly timezone: string; readonly jobRef: string; readonly input: JsonObject;
  readonly creatorPrincipalId: string; readonly creatorRoles: readonly ("owner" | "member" | "guest" | "system")[]; readonly authority: Authority;
  readonly destination?: JsonObject; readonly misfirePolicy: MisfirePolicy; readonly maxAttempts: number; readonly retryBackoffMs: number;
  readonly nextFireAt: string | null; readonly createdAt: string; readonly updatedAt: string;
}
export interface ScheduledOccurrence {
  readonly id: string; readonly triggerId: string; readonly scheduledFor: string; readonly status: "running" | "succeeded" | "failed";
  readonly attempts: number; readonly runId: string; readonly nextRetryAt?: string; readonly error?: string; readonly claimedAt: string; readonly completedAt?: string;
}
export interface CreateScheduledTrigger extends Omit<ScheduledTrigger, "revision" | "createdAt" | "updatedAt"> { readonly createdAt: string }
export interface SchedulerStore {
  createScheduledTrigger(trigger: CreateScheduledTrigger): Promise<ScheduledTrigger>;
  listScheduledTriggers(): Promise<readonly ScheduledTrigger[]>;
  getScheduledTrigger(id: string): Promise<ScheduledTrigger | undefined>;
  getScheduledOccurrence(id: string): Promise<ScheduledOccurrence | undefined>;
  setScheduledTriggerEnabled(id: string, enabled: boolean, nextFireAt: string | null, expectedRevision: number, updatedAt: string): Promise<ScheduledTrigger>;
  deleteScheduledTrigger(id: string): Promise<boolean>;
  listDueScheduledTriggers(now: string, limit: number): Promise<readonly ScheduledTrigger[]>;
  claimScheduledOccurrence(triggerId: string, expectedRevision: number, scheduledFor: string, nextFireAt: string | null, disable: boolean, occurrenceId: string, runId: string, claimedAt: string): Promise<ScheduledOccurrence | undefined>;
  listRetryableScheduledOccurrences(now: string, limit: number): Promise<readonly ScheduledOccurrence[]>;
  claimScheduledRetry(occurrenceId: string, expectedAttempts: number, runId: string, claimedAt: string): Promise<ScheduledOccurrence | undefined>;
  completeScheduledOccurrence(id: string, completedAt: string): Promise<void>;
  failScheduledOccurrence(id: string, error: string, nextRetryAt: string | undefined, completedAt: string): Promise<void>;
  recoverScheduledOccurrences(recoveredAt: string): Promise<number>;
}
export interface SchedulerControl {
  create(input: Omit<CreateScheduledTrigger, "id" | "nextFireAt" | "createdAt">, idempotencyKey?: string): Promise<ScheduledTrigger>;
  list(): Promise<readonly ScheduledTrigger[]>;
  setEnabled(id: string, enabled: boolean): Promise<ScheduledTrigger>;
  remove(id: string): Promise<boolean>;
}
