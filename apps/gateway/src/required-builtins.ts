import type { JsonObject } from "@umiro/core";

export const REQUIRED_BUILTIN_PLUGIN_IDS = ["context-files", "memory", "host-tools", "discord-tools"] as const;

export interface ManagedPluginEntry {
  readonly source: string;
  readonly path: string;
  readonly workspace?: string;
  readonly enabled: boolean;
  readonly config?: JsonObject;
}

export function validateManagedPluginEntries(value: unknown): readonly ManagedPluginEntry[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item) || typeof item.source !== "string" || typeof item.path !== "string" || typeof item.enabled !== "boolean")) throw new TypeError("plugins.json contains an invalid plugin entry");
  return value as ManagedPluginEntry[];
}

export function assertRequiredBuiltins(entries: readonly ManagedPluginEntry[]): void {
  for (const id of REQUIRED_BUILTIN_PLUGIN_IDS) {
    const source = `builtin:${id}`;
    const entry = entries.find(item => item.source === source);
    if (!entry || entry.enabled !== true) throw new Error(`required built-in capability must be installed and enabled: ${id}`);
  }
}
