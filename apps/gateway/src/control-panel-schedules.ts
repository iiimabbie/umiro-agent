import type { JsonObject, ScheduledTrigger } from "@umiro/core";

export type ScheduleOwner =
  | { readonly kind: "user" }
  | { readonly kind: "plugin"; readonly pluginId: string }
  | { readonly kind: "system"; readonly systemId: string };

export interface ControlPanelScheduleView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule: ScheduledTrigger["schedule"];
  readonly timezone: string;
  readonly nextFireAt: string | null;
  readonly destination?: JsonObject;
  readonly prompt?: string;
  readonly owner: ScheduleOwner;
  readonly actions: {
    readonly canToggle: boolean;
    readonly canEdit: boolean;
    readonly canDelete: boolean;
    readonly settingsTarget?: "plugin" | "conversation";
  };
}

export type ScheduleMutation = "toggle" | "edit" | "delete";

export class ManagedScheduleMutationError extends Error {
  readonly statusCode = 409;
  constructor(readonly schedule: ControlPanelScheduleView, readonly action: ScheduleMutation) {
    const owner = schedule.owner.kind === "plugin"
      ? `plugin ${schedule.owner.pluginId}`
      : schedule.owner.kind === "system" ? `system ${schedule.owner.systemId}` : "managed owner";
    super(`This schedule is managed by ${owner}; change it in ${schedule.owner.kind === "plugin" ? "plugin settings" : "the canonical system settings"}.`);
    this.name = "ManagedScheduleMutationError";
  }
}

export function classifySchedule(trigger: Pick<ScheduledTrigger, "jobRef" | "input">, pluginJobOwners: ReadonlyMap<string, string> = new Map()): ScheduleOwner {
  if (trigger.jobRef === "agent.prompt" && Object.hasOwn(trigger.input, "pluginId")) {
    const pluginId = typeof trigger.input.pluginId === "string" && trigger.input.pluginId.trim() ? trigger.input.pluginId.trim() : "unknown-plugin";
    return { kind: "plugin", pluginId };
  }
  if (trigger.jobRef.startsWith("plugin:")) {
    const jobId = trigger.jobRef.slice("plugin:".length).trim() || "unknown-job";
    return { kind: "plugin", pluginId: pluginJobOwners.get(jobId) ?? jobId };
  }
  if (trigger.jobRef === "agent.prompt") return { kind: "user" };
  return { kind: "system", systemId: trigger.jobRef === "system:conversation-auto-archive" ? "conversation-auto-archive" : trigger.jobRef };
}

export function toControlPanelScheduleView(trigger: ScheduledTrigger, pluginJobOwners: ReadonlyMap<string, string> = new Map()): ControlPanelScheduleView {
  const owner = classifySchedule(trigger, pluginJobOwners);
  const actions = owner.kind === "user"
    ? { canToggle: true, canEdit: true, canDelete: true }
    : owner.kind === "plugin"
      ? { canToggle: false, canEdit: false, canDelete: false, settingsTarget: "plugin" as const }
      : { canToggle: false, canEdit: false, canDelete: false, ...(owner.systemId === "conversation-auto-archive" ? { settingsTarget: "conversation" as const } : {}) };
  return {
    id: trigger.id,
    name: trigger.name,
    enabled: trigger.enabled,
    schedule: trigger.schedule,
    timezone: trigger.timezone,
    nextFireAt: trigger.nextFireAt,
    ...(trigger.destination ? { destination: trigger.destination } : {}),
    ...(owner.kind === "user" && typeof trigger.input.prompt === "string" ? { prompt: trigger.input.prompt } : {}),
    owner,
    actions,
  };
}

export function assertUserManagedSchedule(schedule: ControlPanelScheduleView, action: ScheduleMutation): void {
  if (schedule.owner.kind !== "user") throw new ManagedScheduleMutationError(schedule, action);
}
