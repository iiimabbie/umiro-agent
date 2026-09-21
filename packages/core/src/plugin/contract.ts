import type { Authority, AuthorityScopeRequest } from "../authorization/authority.js";
import type { ContextBlock, ContextProvider } from "../context/contract.js";
import type { InputEvent } from "../input/event.js";
import type { JsonObject } from "../ports/json.js";
import type { ToolDefinition } from "../tool/contract.js";
import type { PluginStateStore } from "./state.js";
import type { PluginHookDefinition } from "./hooks.js";
import type { ConversationSearch, PluginSearchDocuments, SearchDocumentProjection } from "../search/contract.js";
import type { SchedulerControl } from "../scheduler/contract.js";
import type { ChildRunService } from "../delegation/service.js";
import type { Artifact } from "../artifact/entities.js";
import type { BudgetCeiling, OutputContract } from "../delegation/entities.js";

/** Static, author-auditable subagent role. Declared in the manifest only. */
export interface SubagentProfileDefinition {
  readonly id: string;
  readonly description: string;
  readonly instructions: readonly string[];
  readonly model?: string;
  /** Availability requirement, not a per-Run tool allowlist. */
  readonly requiredTools?: readonly string[];
  readonly authorityScope?: AuthorityScopeRequest;
  readonly budgetCeiling?: BudgetCeiling;
  readonly outputContract?: OutputContract;
}

export interface SubagentProfileCatalog {
  list(): readonly SubagentProfileDefinition[];
  get(id: string): SubagentProfileDefinition | undefined;
}

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
  readonly options?: readonly { readonly name: string; readonly description: string; readonly type: "string" | "integer" | "boolean" | "channel"; readonly required?: boolean; readonly autocomplete?: boolean; readonly choices?: readonly { readonly name: string; readonly value: string | number }[] }[];
  readonly autocomplete?: (option: string, value: string, context?: { readonly userId: string; readonly channelId?: string; readonly guildId?: string; readonly signal?: AbortSignal }) => Promise<readonly { readonly name: string; readonly value: string }[]>;
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
  /** Secrets the plugin may consume when configured, but which do not gate loading. */
  readonly optionalSecrets?: readonly string[];
  readonly contributes: {
    readonly tools?: readonly string[];
    readonly contextProviders?: readonly string[];
    readonly turnAnalyzers?: readonly string[];
    readonly hooks?: readonly string[];
    readonly jobs?: readonly string[];
    readonly commands?: readonly string[];
    readonly skills?: readonly string[];
    readonly controlPanelViews?: readonly string[];
    /** Static, author-auditable usage policy rendered by the Host as scoped instructions. */
    readonly policy?: readonly string[];
    /** Manifest-only static definitions; no runtime contribution may override them. */
    readonly subagentProfiles?: readonly SubagentProfileDefinition[];
  };
}

export interface PluginSetupContext {
  readonly pluginId: string;
  readonly namespace: string;
  readonly permissionCeiling: Authority;
  readonly config: JsonObject;
  readonly state?: PluginStateStore;
  readonly services?: PluginRuntimeServices;
  /** Namespaced, secret-redacted observability for non-fatal plugin conditions. */
  readonly logger?: PluginLogger;
  getSecret(name: string): string | undefined;
}

export interface PluginLogger {
  readonly debug: (event: string, message: string, data?: JsonObject) => void;
  readonly info: (event: string, message: string, data?: JsonObject) => void;
  readonly warn: (event: string, message: string, data?: JsonObject) => void;
  readonly error: (event: string, message: string, data?: JsonObject) => void;
}

export interface PluginArtifactService {
  read(input: { readonly artifactId: string; readonly principalId: string }): Promise<{ readonly bytes: Uint8Array; readonly filename?: string; readonly mediaType: string } | undefined>;
  createFromBytes(input: { readonly bytes: Uint8Array; readonly ownerPrincipalId: string; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string }; readonly workspaceRelativePath?: string }): Promise<Artifact>;
  createFromWorkspaceFile(input: { readonly sourcePath: string; readonly ownerPrincipalId: string; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string } }): Promise<Artifact>;
  resolveWorkspaceFileForModel?(input: { readonly sourcePath: string; readonly ownerPrincipalId: string; readonly parentSource?: { readonly kind: string; readonly id: string } }): Promise<Artifact>;
  moveWorkspaceFile(input: { readonly sourcePath: string; readonly destinationPath: string }): Promise<{ readonly oldPath: string; readonly newPath: string }>;
  getWorkspaceRelativePath(artifactId: string): Promise<string | undefined>;
}
/** Protocol-neutral Discord operations exposed to Plugins; adapter enforces transport details. */
export interface DiscordPluginService {
  /** Register a durable action button set and publish it to Discord. */
  readonly createButtonSet: (input: {
    readonly channelId: string;
    readonly content: string;
    readonly allowedUserIds: readonly string[];
    readonly expiresInMinutes?: number;
    readonly creatorPrincipalId?: string;
    readonly buttons: readonly {
      readonly id: string;
      readonly label: string;
      readonly style: "primary" | "secondary" | "success" | "danger";
      readonly actionTool: string;
      readonly actionArgs: JsonObject;
      /** A successful all-items action makes every button in the set unavailable. */
      readonly disableAllOnComplete?: boolean;
    }[];
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly messageId: string; readonly buttonSetId: string; readonly expiresAt: string }>;
  sendButtons(input: { readonly buttonSetId: string; readonly channelId: string; readonly content: string; readonly buttons: readonly { readonly id: string; readonly label: string; readonly style: "primary" | "secondary" | "success" | "danger" }[]; readonly signal?: AbortSignal }): Promise<{ readonly messageId: string }>;
  sendMessage(input: { readonly channelId: string; readonly content: string; readonly signal?: AbortSignal }): Promise<{ readonly messageId: string }>;
  react(input: { readonly channelId: string; readonly messageId: string; readonly emoji: string; readonly signal?: AbortSignal }): Promise<void>;
  pin(input: { readonly channelId: string; readonly messageId: string; readonly signal?: AbortSignal }): Promise<void>;
  unpin(input: { readonly channelId: string; readonly messageId: string; readonly signal?: AbortSignal }): Promise<void>;
  fetchMessage(input: { readonly channelId: string; readonly messageId: string; readonly signal?: AbortSignal }): Promise<{ readonly messageId: string; readonly channelId: string; readonly authorId: string; readonly content: string; readonly createdAt: string; readonly replyToMessageId?: string; readonly referenceChannelId?: string }>;
  createThread(input: { readonly channelId: string; readonly name: string; readonly messageId?: string; readonly signal?: AbortSignal }): Promise<{ readonly threadId: string }>;
  createForumPost(input: { readonly channelId: string; readonly title: string; readonly content: string; readonly signal?: AbortSignal }): Promise<{ readonly threadId: string }>;
  archiveThread(input: { readonly channelId: string; readonly threadId: string; readonly signal?: AbortSignal }): Promise<void>;
  deleteThread(input: { readonly channelId: string; readonly threadId: string; readonly signal?: AbortSignal }): Promise<void>;
  editMessage(input: { readonly channelId: string; readonly messageId: string; readonly content: string; readonly signal?: AbortSignal }): Promise<void>;
  deleteMessage(input: { readonly channelId: string; readonly messageId: string; readonly signal?: AbortSignal }): Promise<void>;
  fetchChannelMessages(input: { readonly channelId: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<readonly { readonly messageId: string; readonly authorId: string; readonly content: string; readonly createdAt: string; readonly replyToMessageId?: string; readonly referenceChannelId?: string }[]>;
  setRespondToBots(enabled: boolean): Promise<void>;
}
export interface IntermediateReplyService { send(runId: string, text: string, signal?: AbortSignal): Promise<{ readonly deliveryId: string }> }
/** Read-only, dialogue-only projection of canonical conversation history for workflows such as journals. */
export interface PluginConversationHistoryService {
  transcriptByDate(input: { readonly date: string; readonly timezone: string; readonly maxCharacters?: number }): Promise<{
    readonly date: string;
    readonly timezone: string;
    readonly conversations: number;
    readonly messages: number;
    readonly text: string;
    readonly truncated: boolean;
  }>;
}
export interface PluginRuntimeServices { readonly conversationSearch?: ConversationSearch; readonly conversationHistory?: PluginConversationHistoryService; readonly searchDocuments?: PluginSearchDocuments; readonly scheduler?: SchedulerControl; readonly childRuns?: ChildRunService; readonly subagentProfiles?: SubagentProfileCatalog; readonly replies?: IntermediateReplyService; readonly artifacts?: PluginArtifactService; readonly discord?: DiscordPluginService }
export interface PluginHostServices extends Omit<PluginRuntimeServices, "searchDocuments"> { readonly searchDocumentProjection?: SearchDocumentProjection }

export interface PluginEnableOptions {
  readonly config?: JsonObject;
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface PluginContributions {
  readonly tools?: readonly ToolDefinition[];
  readonly contextProviders?: readonly ContextProvider[];
  readonly turnAnalyzers?: readonly TurnAnalyzer[];
  readonly hooks?: readonly PluginHookDefinition[];
  readonly jobs?: readonly PluginJobDefinition[];
  readonly commands?: readonly PluginCommandDefinition[];
  readonly skills?: readonly SkillDefinition[];
  readonly controlPanelViews?: readonly PluginControlPanelViewDefinition[];
}

/** A safe, declarative read-only Markdown collection exposed by a plugin. */
export interface PluginControlPanelDocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly occurredAt?: string;
}

export interface PluginControlPanelDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly occurredAt?: string;
}

export interface PluginControlPanelViewDefinition {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: "read-only-markdown-collection";
  list(): Promise<readonly PluginControlPanelDocumentSummary[]>;
  read(id: string): Promise<PluginControlPanelDocument | undefined>;
}

export interface TurnToolCandidate {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface TurnAnalyzerInput {
  readonly event: InputEvent;
  readonly text: string;
  readonly defaultShouldReply: boolean;
  readonly tools: readonly TurnToolCandidate[];
  readonly signal?: AbortSignal;
}

export interface TurnAnalysis {
  readonly shouldReply: boolean;
  readonly selectedToolNames: readonly string[];
  readonly contextBlocks: readonly ContextBlock[];
}

export interface TurnAnalyzer {
  readonly id: string;
  analyze(input: TurnAnalyzerInput): Promise<TurnAnalysis | undefined>;
}

/** A declarative orchestration guide. Skills can only reference registered tools/models. */
export interface SkillDefinition {
  readonly id: string;
  readonly description: string;
  readonly requiredTools?: readonly string[];
  readonly requiredModels?: readonly string[];
  readonly instructions: string;
}

export interface PluginInstance {
  readonly contributions: PluginContributions;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  /** Lightweight liveness/readiness check; must not mutate plugin state. */
  health?(): Promise<{ readonly status: "ok" | "degraded" | "failed"; readonly detail?: string }>;
}

export interface PluginHealth {
  readonly id: string;
  readonly status: "ok" | "degraded" | "failed";
  readonly detail?: string;
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
