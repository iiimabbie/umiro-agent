import type { Authority } from "../authorization/authority.js";
import type { ContextProvider } from "../context/contract.js";
import type { JsonObject } from "../ports/json.js";
import type { ToolDefinition } from "../tool/contract.js";
import type { PluginStateStore } from "./state.js";
import type { PluginHookDefinition } from "./hooks.js";
import type { ConversationSearch } from "../search/contract.js";
import type { SchedulerControl } from "../scheduler/contract.js";

/** Protocol-neutral declarations; Scheduler/Adapter registries consume these later. */
export interface PluginJobDefinition {
  readonly id: string;
  readonly schedule: string;
  readonly timezone?: string;
  readonly misfirePolicy?: "catch_up" | "coalesce" | "skip";
  readonly maxAttempts?: number;
  readonly retryBackoffMs?: number;
  readonly run: (context: { readonly jobId: string; readonly signal?: AbortSignal }) => Promise<void>;
}

export interface PluginCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly ownerOnly?: boolean;
  readonly ephemeral?: boolean;
  readonly options?: readonly { readonly name: string; readonly description: string; readonly type: "string" | "integer" | "boolean" | "channel"; readonly required?: boolean; readonly choices?: readonly { readonly name: string; readonly value: string | number }[] }[];
  readonly execute: (input: JsonObject, context?: { readonly userId: string; readonly channelId?: string; readonly guildId?: string; readonly signal?: AbortSignal }) => Promise<JsonObject>;
}

export const PLUGIN_API_VERSION = "0";

export interface PluginManifestV0 {
  readonly schemaVersion: 0;
  readonly id: string;
  readonly version: string;
  readonly coreApi: typeof PLUGIN_API_VERSION;
  readonly entry: string;
  readonly permissions: Authority;
  readonly namespace: string;
  readonly configSchema?: Record<string, unknown>;
  readonly requiredSecrets?: readonly string[];
  readonly contributes: {
    readonly tools?: readonly string[];
      readonly contextProviders?: readonly string[];
    readonly hooks?: readonly string[];
    readonly jobs?: readonly string[];
    readonly commands?: readonly string[];
  };
}

export interface PluginSetupContext {
  readonly pluginId: string;
  readonly namespace: string;
  readonly permissionCeiling: Authority;
  readonly config: JsonObject;
  readonly state?: PluginStateStore;
  readonly services?: PluginHostServices;
  getSecret(name: string): string | undefined;
}

export interface LegacyPluginServices {
  readonly configDirectory: string;
  ask(prompt: string, options?: { readonly systemPrompt?: string; readonly maxTurns?: number; readonly model?: string }): Promise<{ readonly text: string }>;
  sendText(input: { readonly channelId: string; readonly content: string }): Promise<{ readonly messageId: string }>;
  editText(input: { readonly channelId: string; readonly messageId: string; readonly content: string }): Promise<{ readonly messageId: string; readonly migrated: boolean }>;
}
export interface PluginHostServices { readonly conversationSearch?: ConversationSearch; readonly scheduler?: SchedulerControl; readonly legacy?: LegacyPluginServices }

export interface PluginEnableOptions {
  readonly config?: JsonObject;
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface PluginContributions {
  readonly tools?: readonly ToolDefinition[];
    readonly contextProviders?: readonly ContextProvider[];
    readonly hooks?: readonly PluginHookDefinition[];
    readonly jobs?: readonly PluginJobDefinition[];
    readonly commands?: readonly PluginCommandDefinition[];
}

export interface PluginInstance {
  readonly contributions: PluginContributions;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface PluginModule {
  readonly manifest: PluginManifestV0;
  create(context: PluginSetupContext): PluginInstance | Promise<PluginInstance>;
}

export type PluginState = "disabled" | "starting" | "enabled" | "stopping" | "failed";

export interface LoadedPlugin {
  readonly id: string;
  readonly manifest: PluginManifestV0;
  readonly state: PluginState;
  readonly error?: string;
}
