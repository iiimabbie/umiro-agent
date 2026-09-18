import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { isDeepStrictEqual, promisify } from "node:util";
import { capabilities, ChildRunService, ContextEngine, ContextProviderRegistry, ExecutionStoreConflictError, HeadlessRecoveryCoordinator, HeadlessRunEngine, InteractiveIngress, PluginHookRegistry, PluginHost, ToolRegistry, intersectAuthority, type ConversationLocation, type ConversationPreferences, type JsonObject, type ModelCapability, type PluginManifestV0, type ReasoningEffort } from "@umiro/core";
import { decideDiscordIngress, DiscordDeliveryWorker, DiscordIdentityResolver, DiscordJsAdapter, parseDiscordTriggerPolicy, toInputEvent, type DiscordAdapterErrorContext, type DiscordButtonInteraction, type DiscordInteractionContext, type DiscordTriggerPolicyConfig } from "@umiro/adapter-discord";
import { OpenAIChatCompletionsModel, OpenAIModelCatalog, OpenAIResponsesModel, callResponsesImageGeneration, callResponsesWebSearch } from "@umiro/model-openai";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { loadPluginManifest, loadPluginModule } from "./plugin-loader.js";
import { orderPluginEnableEntries, pluginSecretsFromEnvironment } from "./plugin-composition.js";
import { umiroPaths } from "./paths.js";
import { EmbeddingWorker, HybridConversationSearch } from "./embedding-worker.js";
import { createConfiguredEmbedder, EMBEDDING_API_KEY_SECRET, type EmbeddingConfig } from "./embedding-config.js";
import { reconcilePluginSchedules, DurableScheduler, previewNextFire, type PluginRuntimeState } from "./durable-scheduler.js";
import { ArtifactFileService } from "./artifact-files.js";
import { acquireSingletonLock } from "./singleton-lock.js";
import { SemanticRecallProvider } from "./semantic-recall.js";
import { JsonLineLogger } from "./structured-logger.js";
import { ControlPanelServer, validateControlConfig } from "./control-panel.js";
import { artifactModelContent } from "./artifact-input.js";
import { ActiveWorkTracker } from "./active-work.js";
import { SteerGate } from "./steer-gate.js";
import { summarizeModelUsage, type ModelPricing } from "./usage-summary.js";
import { observeExecutionStore, type CoreExecutionEventName } from "./execution-events.js";
import { modelProtocolMap, OpenAIProtocolRouter, parseOpenAIProtocol, resolveDelegatedModel, type OpenAIProtocol } from "./model-routing.js";
import { resolveRuntimeAuthorities, type RuntimeAuthorityConfig } from "./authority-config.js";
import { PluginConversationHistory } from "./plugin-conversation-history.js";
import { createCurrentTimeContextProvider, createDiscordApplicationEmojiContextProvider, discordOutputPolicyProvider, discordRuntimeContextProvider } from "./discord-context.js";
import { ButtonActionCoordinator } from "./button-action-coordinator.js";
import { importDiscordAttachments } from "./discord-attachments.js";
import { safeErrorMessage } from "./safe-error.js";
import { describeImageArtifacts } from "./image-description.js";
import { assertRequiredBuiltins, validateManagedPluginEntries } from "./required-builtins.js";
import { completePendingRestart, savePendingRestart } from "./restart-notification.js";

const paths = umiroPaths();
const pendingRestartFile = `${paths.state}/pending-restart.json`;
const processStart = new Date().toISOString();
const releaseIdentity = await readFile(`${paths.app}/current/install-manifest.json`, "utf8").then(raw => {
  const manifest = JSON.parse(raw) as { releaseId?: unknown; revision?: unknown; installedAt?: unknown };
  return { mode: "installed", ...(typeof manifest.releaseId === "string" ? { releaseId: manifest.releaseId } : {}), ...(typeof manifest.revision === "string" ? { revision: manifest.revision } : {}), ...(typeof manifest.installedAt === "string" ? { installedAt: manifest.installedAt } : {}) };
}).catch(() => ({ mode: "source" }));
const readiness: { storage: boolean; plugins: boolean; discord: boolean; scheduler: boolean; configurationRequired: string[]; shuttingDown: boolean } = { storage: false, plugins: false, discord: false, scheduler: false, configurationRequired: [], shuttingDown: false };
const exec = promisify(execFile);
const releaseSingletonLock = await acquireSingletonLock(`${paths.state}/gateway.lock`);
try { process.loadEnvFile(paths.secrets); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
type ConfigModelProfile = { readonly model: string; readonly protocol?: OpenAIProtocol; readonly capabilities?: readonly ModelCapability[]; readonly reasoningEffort?: ReasoningEffort };
type RuntimeModelProfile = { readonly id: string; readonly model: string; readonly protocol: OpenAIProtocol; readonly capabilities: readonly ModelCapability[]; readonly reasoningEffort?: ReasoningEffort };
type GatewayConfig = { model: string; protocol?: OpenAIProtocol; modelCapabilities?: readonly ModelCapability[]; profiles?: Record<string, ConfigModelProfile>; contextMaxTokens?: number; pricing?: Record<string, ModelPricing>; embedding?: EmbeddingConfig; skills?: readonly string[]; discord?: DiscordTriggerPolicyConfig; authority?: RuntimeAuthorityConfig; subagent?: { maxConcurrentChildren?: number; maxParallelTools?: number }; webUi?: { enabled?: boolean; host?: string; port?: number }; plugins?: Array<{ path: string; config?: JsonObject }> };
const config = validateControlConfig(JSON.parse(await readFile(paths.configFile, "utf8"))) as unknown as GatewayConfig;
const compileModelProfiles = (value: GatewayConfig): { defaultProtocol: OpenAIProtocol; defaultProfile: RuntimeModelProfile; profiles: Record<string, RuntimeModelProfile> } => {
  const protocol = parseOpenAIProtocol(value.protocol);
  const profiles = Object.fromEntries(Object.entries(value.profiles ?? {}).map(([id, profile]) => [id, { id, model: profile.model, protocol: parseOpenAIProtocol(profile.protocol ?? protocol, `profile ${id}.protocol`), capabilities: [...(profile.capabilities ?? [])], ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}) }])) as Record<string, RuntimeModelProfile>;
  return { defaultProtocol: protocol, defaultProfile: { id: "default", model: value.model, protocol, capabilities: [...(value.modelCapabilities ?? [])] }, profiles };
};
const initialModels = compileModelProfiles(config);
let defaultProtocol = initialModels.defaultProtocol;
let configuredProfiles = initialModels.profiles;
let defaultModelProfile = initialModels.defaultProfile;
function resolveModelProfile(selection?: string): RuntimeModelProfile {
  if (!selection || selection === "default") return defaultModelProfile;
  return configuredProfiles[selection] ?? { id: selection, model: selection, protocol: defaultProtocol, capabilities: [] };
}
const allModelCapabilities = [...new Set([...(config.modelCapabilities ?? []), ...Object.values(configuredProfiles).flatMap(profile => profile.capabilities)])] as ModelCapability[];
const startupHostedCapabilities = new Set(allModelCapabilities.filter(capability => capability.startsWith("hosted_")));
let contextMaxTokens = config.contextMaxTokens ?? 24_000;
let discordPolicy = parseDiscordTriggerPolicy(config.discord);
let runtimePricing = config.pricing;
let runtimeMaxParallelTools = config.subagent?.maxParallelTools ?? 2;
let runtimeMaxConcurrentChildren = config.subagent?.maxConcurrentChildren ?? 2;
const managedRaw = validateManagedPluginEntries(JSON.parse(await readFile(`${paths.config}/plugins.json`, "utf8").catch(() => "[]")));
assertRequiredBuiltins(managedRaw);
const managed = managedRaw.filter(item => item.enabled);
const byPath = new Map<string, { path: string; config?: JsonObject }>();
for (const item of managed) byPath.set(item.path, { path: item.path, ...(item.config ? { config: item.config } : {}) });
for (const item of config.plugins ?? []) byPath.set(item.path, item);
const pluginEntries = orderPluginEnableEntries(await Promise.all([...byPath.values()].map(async configured => {
  const module = await loadPluginModule(configured.path);
  if (module.manifest.id !== "context-files") return { configured, module };
  return { configured: { ...configured, config: { ...(configured.config ?? {}), configFile: paths.configFile, ...(config.skills === undefined ? {} : { skills: [...config.skills] }) } }, module };
})));
const configured = pluginEntries.map(entry => entry.configured);
const modules = pluginEntries.map(entry => entry.module);
const disabledManifests: PluginManifestV0[] = [];
for (const entry of managedRaw.filter(item => !item.enabled)) {
  try { disabledManifests.push(await loadPluginManifest(entry.path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const pluginStates = new Map<string, PluginRuntimeState>();
for (const manifest of disabledManifests) pluginStates.set(manifest.id, "disabled");
for (const module of modules) pluginStates.set(module.manifest.id, "enabled");
const pluginJobStates = new Map<string, PluginRuntimeState>();
const pluginJobOwners = new Map<string, string>();
for (const manifest of disabledManifests) for (const jobId of manifest.contributes.jobs ?? []) pluginJobStates.set(jobId, "disabled");
for (const module of modules) for (const jobId of module.manifest.contributes.jobs ?? []) { pluginJobStates.set(jobId, "enabled"); pluginJobOwners.set(jobId, module.manifest.id); }
const hostedWebSearch = allModelCapabilities.includes("hosted_web_search");
const hostedImageGeneration = allModelCapabilities.includes("hosted_image_generation");
const granted = capabilities("tool.catalog", ...(hostedWebSearch ? ["model.hosted_web_search"] : []), ...(hostedImageGeneration ? ["model.hosted_image_generation"] : []), ...modules.flatMap(module => module.manifest.permissions.capabilities));
const { ownerAuthority, memberAuthority } = resolveRuntimeAuthorities(config.authority, granted, [...(discordPolicy.allowedChannels ?? []), ...(discordPolicy.ambientChannels ?? [])]);
const tools = new ToolRegistry();
const discord = new DiscordJsAdapter();
const providers = new ContextProviderRegistry();
providers.register(createCurrentTimeContextProvider());
providers.register(discordRuntimeContextProvider);
providers.register(discordOutputPolicyProvider);
providers.register(createDiscordApplicationEmojiContextProvider(() => discord.applicationEmojis()));
const logger = new JsonLineLogger();
const pluginHooks = new PluginHookRegistry(logger);
let emitPluginEvent = async (_event: CoreExecutionEventName, _payload: JsonObject): Promise<void> => undefined;
const store = observeExecutionStore(new SQLiteExecutionStore(paths.sqlite), { emit: (event, payload) => emitPluginEvent(event, payload) });
const pluginStateNamespaces = new Set(["discord-tools", ...modules.map(module => module.manifest.namespace)]);
const artifacts = new ArtifactFileService(paths.artifacts, store);
const cleanupExpiredPluginState = async (): Promise<void> => {
  const now = new Date().toISOString();
  const removed = (await Promise.all([...pluginStateNamespaces].map(namespace => store.pluginState(namespace).deleteExpired?.(now) ?? 0))).reduce((sum, count) => sum + count, 0);
  if (removed > 0) logger.write({ level: "debug", event: "plugin_state.expired_cleanup", message: "Expired Plugin state entries were removed", occurredAt: now, data: { removed } });
};
await cleanupExpiredPluginState();
const pluginStateCleanupTimer = setInterval(() => { void cleanupExpiredPluginState().catch(error => logger.write({ level: "warn", event: "plugin_state.expired_cleanup_failed", message: "Expired Plugin state cleanup failed", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown" } })); }, 60 * 60 * 1_000);
pluginStateCleanupTimer.unref?.();
const embedder = createConfiguredEmbedder(config.embedding);
const embeddingWorker = embedder ? new EmbeddingWorker(store, embedder.forBackground?.() ?? embedder, 15_000, logger) : undefined;
const search = new HybridConversationSearch(store, embedder, logger);
const conversationHistory = new PluginConversationHistory(store);
const semanticRecall = embedder ? new SemanticRecallProvider(store, embedder, () => new Date(), logger, config.embedding?.provider === "disabled" ? {} : { ...(config.embedding?.recallLimit !== undefined ? { limit: config.embedding.recallLimit } : {}), ...(config.embedding?.minSimilarity !== undefined ? { minSimilarity: config.embedding.minSimilarity } : {}) }) : undefined;
let runtimeRecall = { limit: config.embedding?.provider === "disabled" ? undefined : config.embedding?.recallLimit, minSimilarity: config.embedding?.provider === "disabled" ? undefined : config.embedding?.minSimilarity };
if (semanticRecall) providers.register(semanticRecall);
const scheduler = new DurableScheduler(store, 1000, () => new Date(), error => logger.write({ level: "error", event: "scheduler.tick.failed", message: "Scheduler cycle failed; the next cycle will continue", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown" } }));
let host: PluginHost;
const activeRuns = new Map<string, { readonly controller: AbortController; readonly userId: string }>();
const activeSessions = new Map<string, { readonly runId: string; readonly gate: SteerGate }>();
const activeWork = new ActiveWorkTracker();

const baseUrl = process.env.LLM_BASE_URL?.trim();
if (!baseUrl) throw new Error("LLM_BASE_URL is required");
const apiKey = process.env.LLM_API_KEY?.trim();
const modelConnection = { baseUrl, auth: apiKey ? "bearer" as const : "none" as const, ...(apiKey ? { apiKey } : {}), timeoutMs: 120_000 };
const modelPort = new OpenAIProtocolRouter(new OpenAIResponsesModel(modelConnection), new OpenAIChatCompletionsModel(modelConnection), modelProtocolMap([defaultModelProfile, ...Object.values(configuredProfiles)].map(profile => ({ model: profile.model, protocol: profile.protocol }))), defaultProtocol);
const modelCatalog = new OpenAIModelCatalog(modelConnection);
tools.register({
  name: "tool_catalog",
  description: "List registered tools and whether the current Principal has their declared capability.",
  inputSchema: { type: "object", additionalProperties: false },
  policy: { capability: "tool.catalog", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
  async execute(_input, context) {
    const profile = context.execution.modelProfile ?? defaultModelProfile;
    return { ok: true, effectStatus: "not_applicable", output: tools.list().map(tool => ({ name: tool.name, description: tool.description, capability: tool.policy.capability, tier: tool.policy.tier, sideEffect: tool.policy.sideEffect, available: context.execution.authority.capabilities.includes(tool.policy.capability) && (!tool.policy.capability.startsWith("model.") || profile.capabilities.includes(tool.policy.capability.slice("model.".length) as ModelCapability)) })) };
  },
});
if (hostedWebSearch) tools.register({
  name: "web_search",
  description: "Search the public web through the active model's hosted web search capability.",
  inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 2, maxLength: 2_000 } } },
  policy: { capability: "model.hosted_web_search", tier: "common", interactionRequirement: "not_required", sideEffect: "none" },
  async execute(input, context) {
    const profile = context.execution.modelProfile ?? defaultModelProfile;
    if (!profile.capabilities.includes("hosted_web_search")) return { ok: false, effectStatus: "not_applicable", error: { code: "model_capability_unavailable", message: `model profile ${profile.id} does not provide hosted web search`, retryable: false } };
    try {
      const result = await callResponsesWebSearch({ config: { baseUrl, auth: apiKey ? "bearer" : "none", ...(apiKey ? { apiKey } : {}) }, model: profile.model, query: String(input.query), signal: context.signal });
      return { ok: true, output: { text: result.text, sources: result.sources }, effectStatus: "not_applicable" };
    } catch (error) {
      return { ok: false, effectStatus: "not_applicable", error: { code: "hosted_web_search_unavailable", message: error instanceof Error ? error.message : "hosted web search unavailable", retryable: false } };
    }
  },
});
if (hostedImageGeneration) tools.register({
  name: "image_gen",
  description: "Generate a PNG image through the active model's hosted image generation capability and attach it to the reply.",
  inputSchema: { type: "object", additionalProperties: false, required: ["prompt"], properties: { prompt: { type: "string", minLength: 2, maxLength: 4_000 }, filename: { type: "string", minLength: 1, maxLength: 120 } } },
  policy: { capability: "model.hosted_image_generation", tier: "common", interactionRequirement: "not_required", sideEffect: "non_idempotent", timeoutMs: 120_000 },
  async execute(input, context) {
    const profile = context.execution.modelProfile ?? defaultModelProfile;
    if (!profile.capabilities.includes("hosted_image_generation")) return { ok: false, effectStatus: "unknown", error: { code: "model_capability_unavailable", message: `model profile ${profile.id} does not provide hosted image generation`, retryable: false } };
    try {
      const generated = await callResponsesImageGeneration({ config: { baseUrl, auth: apiKey ? "bearer" : "none", ...(apiKey ? { apiKey } : {}) }, model: profile.model, prompt: String(input.prompt), signal: context.signal });
      const artifact = await artifacts.createFromBytes({ bytes: generated.bytes, ownerPrincipalId: context.execution.actor.id, filename: typeof input.filename === "string" ? input.filename : "generated-image.png", mediaType: "image/png", parentSource: { kind: "operation", id: context.operationId } });
      return { ok: true, output: { artifactId: artifact.id, filename: artifact.filename ?? "generated-image.png" }, artifactIds: [artifact.id], effectStatus: "confirmed" };
    } catch (error) { return { ok: false, effectStatus: "unknown", error: { code: "hosted_image_generation_failed", message: error instanceof Error ? error.message : "hosted image generation failed", retryable: false } }; }
  },
});
const engine = new HeadlessRunEngine(modelPort, tools, store, { maxParallelToolCalls: runtimeMaxParallelTools });
const contextEngine = new ContextEngine(providers);
const childRuns = new ChildRunService(engine, store, { maxActiveChildrenPerPrincipal: runtimeMaxConcurrentChildren, resolveModel: selection => resolveDelegatedModel(selection, defaultModelProfile.model, configuredProfiles) });
await new HeadlessRecoveryCoordinator(store, engine).recoverAll();
await scheduler.recover();
readiness.storage = true;
let ownerDiscordId = process.env.UMIRO_OWNER_DISCORD_ID?.trim() ?? "";
const identities = new DiscordIdentityResolver(store, { ownerDiscordId, ownerAuthority, memberAuthority });
const ingress = new InteractiveIngress(identities, store, store, contextEngine, engine);
const sessionProfile = async (channelId: string) => {
  const preferences = await store.getConversationPreferences("discord", channelId);
  const selected = resolveModelProfile(preferences?.model);
  return { ...selected, reasoningEffort: preferences?.reasoningEffort ?? selected.reasoningEffort ?? "default" as ReasoningEffort, queueMode: preferences?.queueMode ?? discordPolicy.queueMode ?? "queue" as const, preferences };
};
const updateSessionPreferences = async (channelId: string, change: (current: ConversationPreferences | undefined) => Pick<ConversationPreferences, "model" | "reasoningEffort" | "queueMode">) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.getConversationPreferences("discord", channelId);
    const next = change(current);
    try {
      return await store.updateConversationPreferences({ transport: "discord", externalId: channelId, expectedRevision: current?.revision ?? 0, ...(next.model ? { model: next.model, reasoningEffort: next.reasoningEffort! } : {}), ...(next.queueMode ? { queueMode: next.queueMode } : {}), updatedAt: new Date().toISOString() });
    } catch (error) {
      if (!(error instanceof ExecutionStoreConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error("conversation preferences changed repeatedly");
};
await discord.setRespondToBots(discordPolicy.respondToBots === true);
const buttonState = store.pluginState("discord-tools");
const buttonActions = new ButtonActionCoordinator(store, tools);
interface DurableButtonResult { readonly status: "completed" | "failed"; readonly text: string }
interface DurableButtonRecord {
  readonly buttonSetId: string; readonly channelId: string; content?: string; readonly creatorPrincipalId?: string;
  readonly allowedUserIds: string[]; readonly createdAt: string; readonly expiresAt: string; usedButtonIds: string[];
  buttonResults?: Record<string, DurableButtonResult>;
  readonly buttons: Array<{ id: string; label?: string; actionTool: string; actionArgs: JsonObject; disableAllOnComplete?: boolean }>;
}
const buttonText = (value: unknown): string => {
  if (typeof value === "string") return value.trim() || "Completed.";
  if (value === undefined || value === null) return "Completed.";
  const rendered = JSON.stringify(value, null, 2);
  return rendered.length <= 500 ? `\`\`\`json\n${rendered}\n\`\`\`` : `\`\`\`json\n${rendered.slice(0, 497)}...\n\`\`\``;
};
const renderButtonRecord = (record: DurableButtonRecord): string => {
  const sections = record.buttons.flatMap(button => {
    const result = record.buttonResults?.[button.id]; if (!result) return [];
    return [`${result.status === "completed" ? "☑️" : "❌"} **${button.label ?? button.actionTool}**\n${result.text.slice(0, 500)}`];
  });
  const allComplete = record.buttons.every(button => record.usedButtonIds.includes(button.id));
  return [record.content ?? "", ...(sections.length ? ["", ...sections] : []), ...(allComplete ? ["", "狀態：**已完成**"] : [])].join("\n").slice(0, 2_000);
};
const discordPluginService = Object.assign(discord, {
  async createButtonSet(input: {
    readonly channelId: string;
    readonly content: string;
    readonly allowedUserIds: readonly string[];
    readonly expiresInMinutes?: number;
    readonly creatorPrincipalId?: string;
    readonly buttons: readonly { readonly id: string; readonly label: string; readonly style: "primary" | "secondary" | "success" | "danger"; readonly actionTool: string; readonly actionArgs: JsonObject; readonly disableAllOnComplete?: boolean }[];
    readonly signal?: AbortSignal;
  }): Promise<{ readonly messageId: string; readonly buttonSetId: string; readonly expiresAt: string }> {
    if (input.allowedUserIds.length === 0) throw new Error("allowedUserIds is required");
    if (input.buttons.length < 1 || input.buttons.length > 25) throw new TypeError("Discord button set must contain 1 to 25 buttons");
    const buttonSetId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const minutes = input.expiresInMinutes ?? 1_440;
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10_080) throw new TypeError("button expiry must be between 1 and 10080 minutes");
    const expiresAt = new Date(Date.parse(createdAt) + minutes * 60_000).toISOString();
    const record: DurableButtonRecord = { buttonSetId, channelId: input.channelId, content: input.content, ...(input.creatorPrincipalId ? { creatorPrincipalId: input.creatorPrincipalId } : {}), allowedUserIds: [...input.allowedUserIds], buttons: input.buttons.map(button => ({ id: button.id, label: button.label, actionTool: button.actionTool, actionArgs: button.actionArgs, ...(button.disableAllOnComplete ? { disableAllOnComplete: true } : {}) })), createdAt, expiresAt, usedButtonIds: [] };
    await buttonState.writeAtomic(`buttons/${buttonSetId}.json`, new TextEncoder().encode(JSON.stringify(record)), { expiresAt });
    try {
      const sent = await discord.sendButtons({ buttonSetId, channelId: input.channelId, content: input.content, buttons: input.buttons.map(button => ({ id: button.id, label: button.label, style: button.style })), ...(input.signal ? { signal: input.signal } : {}) });
      return { ...sent, buttonSetId, expiresAt };
    } catch (error) {
      await buttonState.remove(`buttons/${buttonSetId}.json`);
      throw error;
    }
  },
});
discord.onButton(async (interaction: DiscordButtonInteraction) => {
    const key = `buttons/${interaction.buttonSetId}.json`;
    const current = await buttonState.readVersioned(key);
    if (!current) throw new Error("button set is unavailable or expired");
    const record = JSON.parse(new TextDecoder().decode(current.value)) as DurableButtonRecord;
    if (record.channelId !== interaction.channelId) throw new Error("button channel does not match");
    if (Date.parse(record.expiresAt) <= Date.now()) { await buttonState.remove(key); throw new Error("button set expired"); }
    if (record.allowedUserIds.length > 0 && !record.allowedUserIds.includes(interaction.userId)) throw new Error("button user is not allowed");
    if (record.usedButtonIds.includes(interaction.buttonId)) throw new Error("button was already used");
    const action = record.buttons.find(button => button.id === interaction.buttonId);
    if (!action) throw new Error("button action does not exist");
    const actionDefinition = tools.get(action.actionTool);
    if (!actionDefinition) throw new Error("button action tool is unavailable");
    record.content ??= interaction.messageContent;
    record.usedButtonIds.push(interaction.buttonId);
    const claimed = await buttonState.compareAndSwap(key, current.version, new TextEncoder().encode(JSON.stringify(record)), { expiresAt: record.expiresAt });
    if (!claimed.updated) throw new Error("button was already claimed");
    const resolved = await identities.resolve({ transport: "discord", externalId: interaction.userId, principalId: null });
    const execution = { actor: resolved.principal, authority: resolved.authority, origin: { kind: "interactive" as const, transport: "discord", conversationId: interaction.channelId } };
    const result = await buttonActions.startAndExecute({ toolName: action.actionTool, toolInput: action.actionArgs, context: execution, idempotencyKey: `button:${interaction.buttonSetId}:${interaction.buttonId}` });
    let finalized: DurableButtonRecord | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const latest = await buttonState.readVersioned(key); if (!latest) throw new Error("button set disappeared during execution");
      const next = JSON.parse(new TextDecoder().decode(latest.value)) as DurableButtonRecord;
      if (result.status === "succeeded" && action.disableAllOnComplete) next.usedButtonIds = next.buttons.map(button => button.id);
      next.buttonResults = { ...(next.buttonResults ?? {}), [interaction.buttonId]: { status: result.status === "succeeded" ? "completed" : "failed", text: result.status === "succeeded" ? buttonText(result.output) : `Action ${result.status}` } };
      const saved = await buttonState.compareAndSwap(key, latest.version, new TextEncoder().encode(JSON.stringify(next)), { expiresAt: next.expiresAt });
      if (saved.updated) { finalized = next; break; }
    }
    if (!finalized) throw new Error("button result changed repeatedly");
    return { messageContent: renderButtonRecord(finalized), disableButtonIds: finalized.usedButtonIds };
});
const runtimeSecrets = () => [process.env.DISCORD_TOKEN, process.env.LLM_API_KEY, process.env[EMBEDDING_API_KEY_SECRET], process.env.GOOGLE_CLIENT_SECRET];
discord.onError((error: unknown, context: DiscordAdapterErrorContext) => logger.write({ level: "error", event: `discord.${context.event}.failed`, message: "Discord event handler failed", occurredAt: new Date().toISOString(), data: { ...context, errorName: error instanceof Error ? error.name : "NonErrorThrown", errorMessage: safeErrorMessage(error, runtimeSecrets()) } }));
const delivery = new DiscordDeliveryWorker(store, discord, () => new Date().toISOString(), store);
const replies = { async send(runId: string, text: string, signal?: AbortSignal) {
  const checkpoint = await store.getCheckpoint(runId);
  const data = checkpoint?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Run ${runId} has no delivery checkpoint`);
  const destination = (data as Record<string, unknown>).deliveryDestination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) throw new Error(`Run ${runId} has no delivery destination`);
  const deliveryId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await store.createDeliveryIntent({ id: deliveryId, runId, destination: structuredClone(destination) as JsonObject, payload: { text }, state: "pending", createdAt });
  await delivery.drain(signal);
  return { deliveryId };
} };
const webUiConfig = config.webUi ?? { enabled: false, host: "127.0.0.1", port: 3210 };
const embeddingRuntimeIdentity = (value: EmbeddingConfig | undefined): unknown => {
  if (!value || value.provider === "disabled") return { provider: "disabled" };
  return { provider: value.provider, model: value.model, ...(value.provider === "openai-compatible" ? { baseUrl: value.baseUrl } : {}), ...(value.requestsPerMinute !== undefined ? { requestsPerMinute: value.requestsPerMinute } : {}) };
};
const changed = (left: unknown, right: unknown): boolean => !isDeepStrictEqual(left, right);
const namedConversationScopes = async (locations: readonly ConversationLocation[]) => {
  const discordIds = locations.filter(location => location.transport === "discord").map(location => location.externalId);
  const catalog = new Map((await discord.listChannels(discordIds)).map(channel => [channel.id, channel]));
  return new Map(locations.map(location => {
    const channel = location.transport === "discord" ? catalog.get(location.externalId) : undefined;
    return [`${location.transport}:${location.externalId}`, {
      transport: location.transport,
      externalId: location.externalId,
      kind: location.kind,
      ...(channel ? { name: channel.name, guildName: channel.guildName, ...(channel.parentName ? { parentName: channel.parentName } : {}) } : {}),
    }];
  }));
};
const editableSecretNames = new Set(["DISCORD_TOKEN", "UMIRO_OWNER_DISCORD_ID", "UMIRO_WEB_UI_TOKEN", "LLM_API_KEY", EMBEDDING_API_KEY_SECRET, ...modules.flatMap(module => module.manifest.requiredSecrets ?? [])]);
const persistSecrets = async (values: Readonly<Record<string, string>>): Promise<void> => {
  const source = await readFile(paths.secrets, "utf8").catch(() => "");
  const lines = source.split(/\r?\n/);
  for (const [name, value] of Object.entries(values)) {
    const replacement = `${name}=${JSON.stringify(value)}`;
    const index = lines.findIndex(line => line.startsWith(`${name}=`));
    if (index >= 0) lines[index] = replacement;
    else lines.push(replacement);
  }
  const temporary = `${paths.secrets}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temporary, `${lines.filter((line, index) => line || index < lines.length - 1).join("\n").trimEnd()}\n`, { mode: 0o600 }); await rename(temporary, paths.secrets); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
};
let connectDiscordFromSecrets: () => Promise<boolean> = async () => false;
let discordStartAttempted = false;
let shutdown: ((exitCode?: number, restart?: boolean) => Promise<void>) | undefined;
let restartRequested = false;
const controlPanel = webUiConfig.enabled === false ? undefined : new ControlPanelServer({ host: webUiConfig.host ?? "127.0.0.1", port: webUiConfig.port ?? 3210, token: process.env.UMIRO_WEB_UI_TOKEN?.trim() ?? "", configFile: paths.configFile, workspace: paths.workspace, schedules: {
  list: () => scheduler.list(),
  create: input => scheduler.create({ name: input.name, enabled: true, schedule: input.kind === "cron" ? { kind: "cron", expression: input.expression! } : { kind: "once", at: input.at! }, timezone: input.timezone, jobRef: "agent.prompt", input: { prompt: input.prompt }, creatorPrincipalId: "owner", creatorRoles: ["owner"], authority: ownerAuthority, ...(input.channelId ? { destination: { kind: "discord", channelId: input.channelId } } : {}), misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 15_000 }),
  setEnabled: (id, enabled) => scheduler.setEnabled(id, enabled),
  update: (id, input) => scheduler.update(id, { name: input.name, schedule: input.kind === "cron" ? { kind: "cron", expression: input.expression! } : { kind: "once", at: input.at! }, timezone: input.timezone, input: { prompt: input.prompt }, ...(input.channelId ? { destination: { kind: "discord", channelId: input.channelId } } : {}), misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 15_000 }),
  remove: id => scheduler.remove(id),
  preview: input => previewNextFire(input.kind === "cron" ? { kind: "cron", expression: input.expression! } : { kind: "once", at: input.at! }, input.timezone),
}, plugins: {
  list: async () => {
    const entries = JSON.parse(await readFile(`${paths.config}/plugins.json`, "utf8").catch(() => "[]")) as Array<Record<string, unknown>>;
    return Promise.all(entries.map(async entry => {
      if (typeof entry.path !== "string") return entry;
      try {
        const manifest = await loadPluginManifest(entry.path);
        return { ...entry, manifest };
      } catch { return entry; }
    }));
  },
  run: async (action, source, workspace, pluginConfig) => {
    const before = validateManagedPluginEntries(JSON.parse(await readFile(`${paths.config}/plugins.json`, "utf8").catch(() => "[]")));
    const target = before.find(entry => entry.source === source && entry.workspace === workspace);
    const targetManifest = target && (action === "disable" || action === "remove") ? await loadPluginManifest(target.path).catch(() => undefined) : undefined;
    const args = ["plugin", action, source, ...(workspace ? ["--workspace", workspace] : []), ...(pluginConfig ? ["--config", JSON.stringify(pluginConfig)] : [])];
    const result = await exec(`${paths.root}/bin/umo`, args, { timeout: 10 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, UMIRO_PLUGIN_ACTION_FROM_GATEWAY: "1" } });
    if (targetManifest && (action === "disable" || action === "remove")) {
      const loaded = host.get(targetManifest.id);
      if (loaded && action === "remove") await host.remove(targetManifest.id);
      else if (loaded?.state === "enabled") await host.disable(targetManifest.id);
      if (action === "disable") {
        pluginStates.set(targetManifest.id, "disabled");
        for (const jobId of targetManifest.contributes.jobs ?? []) pluginJobStates.set(jobId, "disabled");
      } else {
        pluginStates.delete(targetManifest.id);
        for (const jobId of targetManifest.contributes.jobs ?? []) { pluginJobStates.delete(jobId); pluginJobOwners.delete(jobId); }
      }
      await reconcilePluginSchedules(scheduler, pluginStates, pluginJobStates);
    }
    return { ok: true, output: result.stdout.trim(), restartRequired: action !== "disable" && action !== "remove" };
  },
}, workspaceFiles: ["SOUL.md", "AGENT.md", "OWNER.md", "memory/PREFERENCES.md", "memory/LESSONS.md", "memory/WORKFLOWS.md", "memory/ONGOING.md", "memory/FACTS.md", ...(modules.some(module => module.manifest.id === "people") ? ["PEOPLE.md"] : [])], secrets: () => Object.fromEntries([...editableSecretNames].sort().map(name => [name, Boolean(process.env[name]?.trim())])), updateSecrets: async values => {
  const unexpected = Object.keys(values).find(name => !editableSecretNames.has(name));
  if (unexpected) throw new TypeError(`secret is not editable here: ${unexpected}`);
  await persistSecrets(values);
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  const applied: string[] = [];
  const restartRequired: string[] = [];
  if (values.UMIRO_OWNER_DISCORD_ID !== undefined) {
    ownerDiscordId = values.UMIRO_OWNER_DISCORD_ID;
    identities.setOwnerDiscordId(ownerDiscordId);
    applied.push("UMIRO_OWNER_DISCORD_ID");
  }
  if (values.DISCORD_TOKEN !== undefined || values.UMIRO_OWNER_DISCORD_ID !== undefined) {
    if (readiness.discord) { if (values.DISCORD_TOKEN !== undefined) restartRequired.push("DISCORD_TOKEN"); }
    else if (await connectDiscordFromSecrets()) applied.push(...Object.keys(values).filter(name => name === "DISCORD_TOKEN" || name === "UMIRO_OWNER_DISCORD_ID"));
    else if (values.DISCORD_TOKEN !== undefined) restartRequired.push("DISCORD_TOKEN");
  }
  for (const name of Object.keys(values)) if (name !== "DISCORD_TOKEN" && name !== "UMIRO_OWNER_DISCORD_ID") restartRequired.push(name);
  return { applied: [...new Set(applied)], restartRequired: [...new Set(restartRequired)] };
}, models: () => modelCatalog.listConversationModels(), applyConfig: async raw => {
  const next = raw as unknown as GatewayConfig;
  const applied: string[] = [];
  const restartRequired: string[] = [];
  const applyIfChanged = (path: string, before: unknown, after: unknown, apply: () => void): void => { if (!changed(before, after)) return; apply(); applied.push(path); };
  const restartIfChanged = (path: string, before: unknown, after: unknown): void => { if (changed(before, after)) restartRequired.push(path); };

  restartIfChanged("skills", config.skills, next.skills);
  restartIfChanged("embedding.provider", embeddingRuntimeIdentity(config.embedding), embeddingRuntimeIdentity(next.embedding));
  restartIfChanged("authority", config.authority, next.authority);
  restartIfChanged("plugins", config.plugins, next.plugins);
  restartIfChanged("webUi", config.webUi, next.webUi);

  const nextModels = compileModelProfiles(next);
  const nextCapabilities = [...new Set([...nextModels.defaultProfile.capabilities, ...Object.values(nextModels.profiles).flatMap(profile => profile.capabilities)])];
  const unsupportedHostedCapability = nextCapabilities.some(capability => capability.startsWith("hosted_") && !startupHostedCapabilities.has(capability));
  const modelsChanged = changed({ defaultProtocol, defaultModelProfile, configuredProfiles }, { defaultProtocol: nextModels.defaultProtocol, defaultModelProfile: nextModels.defaultProfile, configuredProfiles: nextModels.profiles });
  if (modelsChanged && unsupportedHostedCapability) restartRequired.push("model", "protocol", "profiles", "modelCapabilities");
  else if (modelsChanged) {
    defaultProtocol = nextModels.defaultProtocol;
    defaultModelProfile = nextModels.defaultProfile;
    configuredProfiles = nextModels.profiles;
    modelPort.configure(modelProtocolMap([defaultModelProfile, ...Object.values(configuredProfiles)].map(profile => ({ model: profile.model, protocol: profile.protocol }))), defaultProtocol);
    applied.push("model", "protocol", "profiles", "modelCapabilities");
  }

  applyIfChanged("contextMaxTokens", contextMaxTokens, next.contextMaxTokens ?? 24_000, () => { contextMaxTokens = next.contextMaxTokens ?? 24_000; });
  applyIfChanged("pricing", runtimePricing, next.pricing, () => { runtimePricing = next.pricing; });

  const nextDiscordPolicy = parseDiscordTriggerPolicy(next.discord);
  if (changed(discordPolicy, nextDiscordPolicy)) {
    const authorities = resolveRuntimeAuthorities(config.authority, granted, [...(nextDiscordPolicy.allowedChannels ?? []), ...(nextDiscordPolicy.ambientChannels ?? [])]);
    identities.setAuthorities(authorities.ownerAuthority, authorities.memberAuthority);
    discordPolicy = nextDiscordPolicy;
    await discord.setRespondToBots(discordPolicy.respondToBots === true);
    await discord.setPresence(discordPolicy.presence ?? {});
    applied.push("discord");
  }

  applyIfChanged("subagent.maxParallelTools", runtimeMaxParallelTools, next.subagent?.maxParallelTools ?? 2, () => { runtimeMaxParallelTools = next.subagent?.maxParallelTools ?? 2; engine.setMaxParallelToolCalls(runtimeMaxParallelTools); });
  applyIfChanged("subagent.maxConcurrentChildren", runtimeMaxConcurrentChildren, next.subagent?.maxConcurrentChildren ?? 2, () => { runtimeMaxConcurrentChildren = next.subagent?.maxConcurrentChildren ?? 2; childRuns.setMaxActiveChildrenPerPrincipal(runtimeMaxConcurrentChildren); });

  const nextRecall = { limit: next.embedding?.provider === "disabled" ? undefined : next.embedding?.recallLimit, minSimilarity: next.embedding?.provider === "disabled" ? undefined : next.embedding?.minSimilarity };
  if (changed(runtimeRecall, nextRecall) && !restartRequired.includes("embedding.provider")) {
    semanticRecall?.configure({ ...(nextRecall.limit !== undefined ? { limit: nextRecall.limit } : {}), ...(nextRecall.minSimilarity !== undefined ? { minSimilarity: nextRecall.minSimilarity } : {}) });
    runtimeRecall = nextRecall;
    applied.push("embedding.recallLimit", "embedding.minSimilarity");
  }
  return { applied: [...new Set(applied)], restartRequired: [...new Set(restartRequired)] };
}, audit: (event, data) => logger.write({ level: "info", event, message: "Authenticated control-panel mutation completed", occurredAt: new Date().toISOString(), data }), runs: {
  list: async (limit: number) => Promise.all((await store.listRuns(limit)).map(async run => { const output = await store.getRunOutput(run.id); const origin = run.context.origin; const binding = run.conversationId ? await store.getConversationBinding(run.conversationId) : undefined; return { id: run.id, state: run.state, origin: origin.kind, ...(binding?.transport === "discord" ? { channelId: binding.externalId } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt, ...(output ? { usage: output.usage } : {}) }; })),
  get: async (id: string) => { const run = await store.getRun(id); if (!run) return undefined; return { run, steps: await store.listSteps(id), operations: await store.listOperations(id), modelCalls: await store.listModelCalls(id), output: await store.getRunOutput(id), audit: await store.listAuditEvents(id) }; },
}, conversations: {
  list: async filter => {
    const summaries = await store.listConversations({ ...(filter.scope ? filter.scope : {}), ...(filter.state ? { state: filter.state } : {}), limit: filter.limit });
    const scopes = await namedConversationScopes(summaries.map(summary => summary.location));
    return summaries.map(summary => ({
      id: summary.conversation.id,
      state: summary.conversation.state,
      scope: scopes.get(`${summary.location.transport}:${summary.location.externalId}`)!,
      createdAt: summary.conversation.createdAt,
      lastActivityAt: summary.lastActivityAt,
      turnCount: summary.turnCount,
      ...(summary.firstText ? { firstText: summary.firstText } : {}),
    }));
  },
  messages: async (conversationId, limit, after) => {
    const page = await store.listConversationMessages(conversationId, limit, after);
    if (!page) return undefined;
    const scopes = await namedConversationScopes([page.location]);
    const scope = scopes.get(`${page.location.transport}:${page.location.externalId}`)!;
    return {
      conversation: { id: page.conversation.id, state: page.conversation.state, scope, createdAt: page.conversation.createdAt },
      messages: page.messages.map(item => {
        const text = item.turn.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        const attachments = item.turn.content.filter(block => block.type === "artifact_reference").length;
        return {
          turnId: item.turn.id,
          sequence: item.turn.sequence,
          at: item.turn.createdAt,
          author: { principalId: item.turn.actorPrincipalId, ...(item.actorDisplayName ? { displayName: item.actorDisplayName } : {}), isOwner: item.turn.actorPrincipalId === "owner" },
          text,
          ...(attachments ? { attachments } : {}),
          ...(item.turn.replyToTurnId ? { replyToTurnId: item.turn.replyToTurnId } : {}),
          observed: !item.turn.primaryRunId,
          ...(item.reply ? { reply: item.reply } : {}),
        };
      }),
      hasMore: page.hasMore,
    };
  },
}, channels: { list: async () => discord.listChannels((await store.listConversationScopes("discord")).map(scope => scope.externalId)) }, logs: limit => logger.list(limit), usage: async () => { const runs = await store.listRuns(200); const calls = (await Promise.all(runs.map(run => store.listModelCalls(run.id)))).flat(); return { sampledRuns: runs.length, ...summarizeModelUsage(calls, runtimePricing) }; }, runtime: () => ({ status: "running", pid: process.pid, startedAt: processStart, release: releaseIdentity, ready: readiness.storage && readiness.plugins && readiness.discord && readiness.scheduler && !readiness.shuttingDown, readiness, bot: discord.identity(), plugins: host?.list().map(item => ({ id: item.id, state: item.state })) ?? [] }), readiness: async () => { if (restartRequested) return { ...readiness, shuttingDown: true }; return { ...readiness, plugins: readiness.plugins && (await host.health()).every(item => item.status === "ok") }; }, restart: () => { setTimeout(() => { if (shutdown) void shutdown(0, true); else restartRequested = true; }, 150); }, processId: process.pid });
host = new PluginHost(tools, providers, ownerAuthority, namespace => store.pluginState(namespace), pluginHooks, undefined, undefined, { conversationSearch: search, conversationHistory, searchDocumentProjection: store, scheduler, childRuns, replies, artifacts, discord: discordPluginService }, undefined, undefined, { has: id => id === "default" || Object.hasOwn(configuredProfiles, id) }, logger);
for (let index = 0; index < modules.length; index++) {
  const module = modules[index]!;
  const secrets = pluginSecretsFromEnvironment(module.manifest, process.env);
  await host.enable(module, { config: configured[index]!.config ?? {}, secrets });
}
emitPluginEvent = (event, payload) => host.emitHook(event, payload);
await reconcilePluginSchedules(scheduler, pluginStates, pluginJobStates);
await scheduler.syncPluginJobs(host.listJobs(), pluginJobOwners);
const enabledSearchNamespaces = new Set(host.list().filter(plugin => plugin.state === "enabled").map(plugin => plugin.manifest.namespace));
for (const namespace of await store.listSearchNamespaces()) if (!enabledSearchNamespaces.has(namespace)) await store.removeSearchNamespace(namespace);
readiness.plugins = true;
embeddingWorker?.start();
scheduler.setDispatcher(async (trigger, occurrence, signal) => {
  if (trigger.jobRef.startsWith("plugin:")) { await host.runJob(trigger.jobRef.slice("plugin:".length), signal); return; }
  if (trigger.jobRef !== "agent.prompt" || typeof trigger.input.prompt !== "string") throw new Error(`unsupported scheduled job: ${trigger.jobRef}`);
  const execution = { origin: { kind: "schedule" as const, scheduleId: trigger.id }, actor: { id: trigger.creatorPrincipalId, kind: trigger.creatorRoles.includes("system") ? "system" as const : "human" as const, roles: trigger.creatorRoles }, authority: intersectAuthority(trigger.authority, ownerAuthority) };
  const prompt = `[Scheduled task: ${trigger.name}; originally due ${occurrence.scheduledFor}]\n\n${trigger.input.prompt}`;
  const assembledContext = await contextEngine.assemble({ runId: occurrence.runId, execution, prompt, maxCharacters: 100_000, maxTokens: contextMaxTokens, ...(signal ? { signal } : {}) });
  const result = await engine.run({ runId: occurrence.runId, context: execution, model: typeof trigger.input.model === "string" ? trigger.input.model : defaultModelProfile.model, prompt, assembledContext, ...(trigger.destination ? { deliveryDestination: trigger.destination } : {}), ...(signal ? { signal } : {}) });
  if (result.status !== "succeeded") throw new Error(`scheduled Run ${result.runId} ended ${result.status}`);
  await delivery.drain(signal);
});
const builtinCommands = [
  { name: "stop", description: "Cancel an active Run.", ownerOnly: false, ephemeral: true, options: [{ name: "run_id", description: "Run identifier", type: "string" as const, required: true }] },
  { name: "new", description: "Start a new conversation in this channel; the current one is archived.", ownerOnly: true, ephemeral: true },
  { name: "model", description: "Switch the model for this Discord session.", ownerOnly: true, ephemeral: true, options: [{ name: "name", description: "Model ID, or reset to use the global default.", type: "string" as const, required: true, autocomplete: true }, { name: "effort", description: "Reasoning effort.", type: "string" as const, required: false, choices: ["default", "low", "medium", "high", "xhigh"].map(value => ({ name: value, value })) }] },
  { name: "queue", description: "Set queue or steer mode for this Discord session.", ownerOnly: true, ephemeral: true, options: [{ name: "mode", description: "Message handling mode, or reset for the global default.", type: "string" as const, required: true, choices: ["queue", "steer", "reset"].map(value => ({ name: value, value })) }] },
  { name: "status", description: "Show the current ümiro status.", ownerOnly: true, ephemeral: true },
  { name: "restart", description: "Restart the ümiro Gateway.", ownerOnly: true, ephemeral: true },
  { name: "plugin", description: "Install, update, remove, enable, disable, or list plugins.", ownerOnly: true, ephemeral: true, options: [{ name: "action", description: "Plugin action.", type: "string" as const, required: true, choices: ["list", "install", "update", "remove", "enable", "disable"].map(value => ({ name: value, value })) }, { name: "target", description: "GitHub URL or installed plugin source.", type: "string" as const, required: false }, { name: "workspace", description: "Plugin directory inside a repository.", type: "string" as const, required: false }] },
];
const handleCommand = async (name: string, input: Record<string, string | number | boolean>, commandContext: { userId: string; channelId: string; guildId?: string }) => {
  if (name === "stop") {
    const runId = String(input.run_id ?? "");
    const active = activeRuns.get(runId);
    if (!active) return { stopped: false, runId, reason: "run_not_active" };
    if (active.userId !== commandContext.userId && commandContext.userId !== ownerDiscordId) return { stopped: false, runId, reason: "not_run_owner" };
    active.controller.abort(new Error("stopped by Discord user"));
    return { stopped: true, runId };
  }
  if (name === "new") {
    if (commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
    const archived = await store.archiveBoundConversation("discord", commandContext.channelId, new Date().toISOString());
    return archived ? { archived: true, conversationId: archived.id } : { archived: false, reason: "no_active_conversation" };
  }
  if (name === "model") {
    if (commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
    const model = String(input.name ?? "").trim();
    const effort = String(input.effort ?? "default") as ReasoningEffort;
    if (!model) throw new TypeError("model name is required");
    if (!["default", "low", "medium", "high", "xhigh"].includes(effort)) throw new TypeError("invalid reasoning effort");
    const updated = await updateSessionPreferences(commandContext.channelId, current => ({ ...(model === "reset" ? {} : { model, reasoningEffort: effort }), ...(current?.queueMode ? { queueMode: current.queueMode } : {}) }));
    return { model: updated.model ?? defaultModelProfile.model, reasoningEffort: updated.reasoningEffort ?? "default", source: updated.model ? "session" : "global" };
  }
  if (name === "queue") {
    if (commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
    const mode = String(input.mode ?? "");
    if (mode !== "queue" && mode !== "steer" && mode !== "reset") throw new TypeError("queue mode must be queue, steer, or reset");
    const updated = await updateSessionPreferences(commandContext.channelId, current => ({ ...(current?.model ? { model: current.model, reasoningEffort: current.reasoningEffort! } : {}), ...(mode === "reset" ? {} : { queueMode: mode }) }));
    return { queueMode: updated.queueMode ?? discordPolicy.queueMode ?? "queue", source: updated.queueMode ? "session" : "global" };
  }
  if (name === "status") {
    if (commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
    const profile = await sessionProfile(commandContext.channelId);
    const active = activeSessions.get(commandContext.channelId);
    const schedules = await scheduler.list();
    const plugins = host.list();
    const runs = await store.listRuns(200);
    const calls = (await Promise.all(runs.map(run => store.listModelCalls(run.id)))).flat();
    const usage = summarizeModelUsage(calls, runtimePricing);
    const release = typeof releaseIdentity === "object" && releaseIdentity !== null && "revision" in releaseIdentity && typeof releaseIdentity.revision === "string" ? releaseIdentity.revision : "source";
    const activeSchedules = schedules.filter(item => item.enabled && item.jobRef === "agent.prompt").length;
    const reminders = schedules.filter(item => item.enabled && item.jobRef === "agent.prompt" && item.schedule.kind === "once").length;
    const pluginJobs = schedules.filter(item => item.enabled && item.jobRef.startsWith("plugin:")).length;
    const runState = active ? `執行中（${active.runId}）` : "閒置";
    const fields = [
      { name: "Model", value: `\`${profile.model}\``, inline: true },
      { name: "Reasoning", value: `\`${profile.reasoningEffort}\``, inline: true },
      { name: "Queue Mode", value: `\`${profile.queueMode}\``, inline: true },
      { name: "Current Run", value: runState, inline: true },
      { name: "Tokens", value: `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out（${usage.calls} calls）`, inline: false },
      { name: "Active Sessions", value: `${activeSessions.size}`, inline: true },
      { name: "Crons", value: `${activeSchedules} active / ${schedules.filter(item => item.jobRef === "agent.prompt" && item.schedule.kind === "cron").length} total`, inline: true },
      { name: "Reminders", value: `${reminders} pending`, inline: true },
      { name: "Plugin Jobs", value: `${pluginJobs} scheduled`, inline: true },
      { name: "Plugins", value: plugins.length ? plugins.map(item => `${item.id} (${item.state})`).join(", ") : "none", inline: false },
      { name: "Skills", value: config.skills?.length ? config.skills.join(", ") : "none", inline: false },
    ];
    return { content: `ümiro ${release} · ${discord.identity()?.tag ?? "未連線"}`, embed: { title: "Umiro Status", color: 0x5865f2, fields, timestamp: new Date().toISOString() } };
  }
  if (name === "restart") {
    if (commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
    return { content: "Restarting... wait for me!" };
  }
  if (name === "plugin") {
    if (commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
    const action = String(input.action ?? "list") as "list" | "install" | "update" | "remove" | "enable" | "disable";
    const target = input.target === undefined ? undefined : String(input.target).trim();
    if (action !== "list" && !target) throw new TypeError("plugin target is required");
    if (action === "list") return { content: host.list().map(item => `${item.id}: ${item.state}`).join("\\n") || "目前沒有外掛。" };
    const args = ["plugin", action, target!, ...(input.workspace ? ["--workspace", String(input.workspace)] : [])];
    const result = await exec(`${paths.root}/bin/umo`, args, { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
    return { content: `${action} 完成。${result.stdout.trim()}${action === "install" || action === "update" ? "\\n重啟後完整啟用外掛。" : ""}` };
  }
  const command = host.listCommands().find(candidate => candidate.name === name);
  if (!command) throw new Error(`plugin command not found: ${name}`);
  if (command.ownerOnly !== false && commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
  return host.executeCommand(name, input, commandContext);
};
discord.onCommand([...host.listCommands(), ...builtinCommands], (name: string, input: Record<string, string | number | boolean>, commandContext: { userId: string; channelId: string; guildId?: string }) => activeWork.track(handleCommand(name, input, commandContext)));
discord.onRestart(async interaction => {
  await savePendingRestart(pendingRestartFile, interaction);
  setTimeout(() => { if (shutdown) void shutdown(0, true); else restartRequested = true; }, 150);
});
discord.onAutocomplete(async (name: string, option: string, value: string, context: DiscordInteractionContext) => {
  const pluginCommand = host.listCommands().find(command => command.name === name);
  if (name !== "model") {
    if (!pluginCommand || (pluginCommand.ownerOnly !== false && context.userId !== ownerDiscordId)) return [];
    try { return await host.autocompleteCommand(name, option, value, context); }
    catch (error) { logger.write({ level: "debug", event: "plugin.command.autocomplete_failed", message: "Plugin command autocomplete failed", occurredAt: new Date().toISOString(), data: { command: name, errorType: error instanceof Error ? error.name : "unknown" } }); return []; }
  }
  if (option !== "name" || context.userId !== ownerDiscordId) return [];
  try {
    const needle = value.trim().toLowerCase();
    return (await modelCatalog.listConversationModels()).filter(model => model.toLowerCase().includes(needle)).slice(0, 25).map(model => ({ name: model.slice(0, 100), value: model }));
  } catch (error) {
    logger.write({ level: "debug", event: "model.discovery.failed", message: "Model autocomplete discovery failed", occurredAt: new Date().toISOString(), data: { errorType: error instanceof Error ? error.name : "unknown" } });
    return [];
  }
});
const handleMessage: Parameters<typeof discord.onMessage>[0] = async message => {
  const decision = decideDiscordIngress({
    channelId: message.channelId,
    ...(message.guildId ? { guildId: message.guildId } : {}),
    authorId: message.authorId,
    authorBot: message.authorBot === true,
    botMentioned: message.botMentioned === true,
    replyToBot: message.replyToBot === true,
  }, { ...discordPolicy, respondToBots: discord.respondsToBots() }, ownerDiscordId);
  if (decision.disposition === "ignore") {
    logger.write({ level: "debug", event: "discord.ingress.ignored", message: "Discord event ignored by trigger policy", occurredAt: new Date().toISOString(), data: { reason: decision.reason, channelId: message.channelId, ...(message.guildId ? { guildId: message.guildId } : {}) } });
    return;
  }
  if (decision.disposition === "observe") {
    const observed = await ingress.observe(toInputEvent(message));
    logger.write({ level: "debug", event: "discord.ingress.observed", message: "Discord event evaluated without a Run", occurredAt: new Date().toISOString(), data: { reason: decision.reason, recorded: observed !== undefined, channelId: message.channelId, ...(message.guildId ? { guildId: message.guildId } : {}) } });
    return;
  }
  const stopTyping = discord.startTyping(message.channelId);
  try {
  const profile = await sessionProfile(message.channelId);
  const resolved = await identities.resolve({ transport: "discord", externalId: message.authorId, principalId: null });
  const imported = await importDiscordAttachments(artifacts, message.attachments ?? [], resolved.principal.id, message.messageId, failure => {
    logger.write({ level: "warn", event: "discord.attachment.import_failed", message: "Discord attachment could not be imported; continuing with the message", occurredAt: new Date().toISOString(), data: { messageId: message.messageId, channelId: message.channelId, filename: failure.filename, reason: failure.reason, errorName: failure.error instanceof Error ? failure.error.name : "NonErrorThrown" } });
  });
  const importedArtifacts = imported.artifacts;
  const storedReplyArtifacts = message.replyToMessageId
    ? await artifacts.listBySource({ kind: "discord_message", id: message.replyToMessageId })
    : [];
  const replyResolved = message.replyAuthorId && message.replyToAttachments?.length
    ? await identities.resolve({ transport: "discord", externalId: message.replyAuthorId, principalId: null })
    : undefined;
  const replyImported = message.replyToMessageId && !storedReplyArtifacts.length && replyResolved
    ? await importDiscordAttachments(artifacts, message.replyToAttachments ?? [], replyResolved.principal.id, message.replyToMessageId, failure => {
      logger.write({ level: "warn", event: "discord.reply_attachment.import_failed", message: "Discord reply attachment could not be imported; continuing with the reply text", occurredAt: new Date().toISOString(), data: { messageId: message.messageId, replyToMessageId: message.replyToMessageId!, channelId: message.channelId, filename: failure.filename, reason: failure.reason, errorName: failure.error instanceof Error ? failure.error.name : "NonErrorThrown" } });
    })
    : { artifacts: [], promptSuffix: "" };
  const replyArtifacts = storedReplyArtifacts.length ? storedReplyArtifacts : replyImported.artifacts;
  const artifactIds = importedArtifacts.map(artifact => artifact.id);
  const controller = new AbortController();
  const gate = new SteerGate();
  const event = toInputEvent(message, artifactIds);
  const promptMessage = `[msg:${message.messageId} ${message.createdAt}] <@${message.authorId}>(${message.authorName ?? message.authorId}${message.authorBot ? "; bot" : ""}): ${message.content}${imported.promptSuffix}`;
  const userContent = await artifactModelContent(promptMessage, importedArtifacts, profile.capabilities.includes("vision"), profile.protocol);
  const replyContent = message.replyToMessageId && (message.replyToContent !== undefined || replyArtifacts.length)
    ? await artifactModelContent(`[reply-target] [msg:${message.replyToMessageId} ${message.replyToCreatedAt ?? ""}] <@${message.replyAuthorId ?? "unknown"}>: ${message.replyToContent ?? "[內容無法取得；僅保留 Discord 訊息參照。]"}${replyImported.promptSuffix}`, replyArtifacts, profile.capabilities.includes("vision"), profile.protocol)
    : [];
  const modelContent = [...userContent, ...replyContent];
  const initialTurns = [] as { readonly id: string; readonly actorPrincipalId: string; readonly actorIdentity: { readonly transport: string; readonly externalId: string }; readonly inputEventId: string; readonly content: readonly [{ readonly type: "text"; readonly text: string }]; readonly createdAt: string }[];
  if (message.threadId && message.messageId !== message.threadId && !(await ingress.hasConversation(event))) {
    try {
      const starter = await discord.fetchThreadStarter({ threadId: message.threadId, signal: controller.signal });
      if (starter && starter.messageId !== message.messageId) {
        const starterIdentity = await identities.resolve({ transport: "discord", externalId: starter.authorId, principalId: null, displayName: starter.authorName });
        initialTurns.push({
          id: `turn:discord-starter:${starter.messageId}`,
          actorPrincipalId: starterIdentity.principal.id,
          actorIdentity: { transport: "discord", externalId: starter.authorId },
          inputEventId: `discord:starter:${starter.messageId}`,
          content: [{ type: "text", text: `[System] This is the initial message of thread "${starter.threadName}" (by ${starter.authorName}) [thread_id: ${message.threadId}]:\n${starter.content}` }],
          createdAt: starter.createdAt,
        });
      }
    } catch (error) {
      logger.write({ level: "warn", event: "discord.thread_starter.unavailable", message: "Thread starter could not be loaded; continuing without it", occurredAt: new Date().toISOString(), data: { threadId: message.threadId, errorName: error instanceof Error ? error.name : "NonErrorThrown" } });
    }
  }
  let runKey = event.id;
  const active = { controller, userId: message.authorId };
  const execution = ingress.handle({ event, model: profile.model, modelProfile: { id: profile.id, model: profile.model, capabilities: profile.capabilities, reasoningEffort: profile.reasoningEffort }, reasoningEffort: profile.reasoningEffort, ...(modelContent.length ? { userContent: modelContent } : {}), ...(initialTurns.length ? { initialTurns } : {}), maxContextCharacters: 100_000, maxContextTokens: contextMaxTokens, deliveryDestination: { kind: "discord", channelId: message.channelId }, signal: controller.signal, steerControl: gate, onRunCreated: id => { runKey = id; activeRuns.set(id, active); activeSessions.set(event.conversation.externalId, { runId: id, gate }); } });
  activeRuns.set(runKey, active);
  let result;
  try { result = await execution; } finally { activeRuns.delete(runKey); activeRuns.delete(event.id); if (activeSessions.get(event.conversation.externalId)?.runId === runKey) activeSessions.delete(event.conversation.externalId); }
  stopTyping();
  await delivery.drain();
  if (profile.capabilities.includes("vision") && importedArtifacts.some(artifact => artifact.mediaType.toLowerCase().startsWith("image/")) && store.updateArtifactExtractedText) {
    void describeImageArtifacts(modelPort, profile.model, importedArtifacts, undefined, profile.reasoningEffort).then(async descriptions => {
      for (const item of descriptions) await store.updateArtifactExtractedText!(item.artifactId, item.description!, new Date().toISOString());
      if (descriptions.length) await store.rebuildSearchProjection();
    }).catch(error => logger.write({ level: "warn", event: "artifact.image_description.failed", message: "Image description indexing failed; the original attachment remains available", occurredAt: new Date().toISOString(), data: { messageId: message.messageId, errorName: error instanceof Error ? error.name : "NonErrorThrown", errorMessage: safeErrorMessage(error, runtimeSecrets()) } }));
  }
  } finally {
    stopTyping();
  }
};
discord.onSteer(async message => {
  const activeSession = activeSessions.get(message.threadId ?? message.channelId);
  if (!activeSession) return false;
  const decision = decideDiscordIngress({ channelId: message.channelId, ...(message.guildId ? { guildId: message.guildId } : {}), authorId: message.authorId, authorBot: message.authorBot === true, botMentioned: message.botMentioned === true, replyToBot: message.replyToBot === true }, { ...discordPolicy, respondToBots: discord.respondsToBots() }, ownerDiscordId);
  if (decision.disposition !== "trigger" || (await sessionProfile(message.threadId ?? message.channelId)).queueMode !== "steer") return false;
  const accepted = activeSession.gate.submit(async () => {
    const profile = await sessionProfile(message.threadId ?? message.channelId);
    const resolved = await identities.resolve({ transport: "discord", externalId: message.authorId, principalId: null });
    const importedResult = await importDiscordAttachments(artifacts, message.attachments ?? [], resolved.principal.id, message.messageId, failure => {
      logger.write({ level: "warn", event: "discord.attachment.import_failed", message: "Discord attachment could not be imported; continuing with the steer message", occurredAt: new Date().toISOString(), data: { messageId: message.messageId, channelId: message.channelId, filename: failure.filename, reason: failure.reason, errorName: failure.error instanceof Error ? failure.error.name : "NonErrorThrown" } });
    });
    const imported = importedResult.artifacts;
    const storedReplyArtifacts = message.replyToMessageId
      ? await artifacts.listBySource({ kind: "discord_message", id: message.replyToMessageId })
      : [];
    const replyResolved = message.replyAuthorId && message.replyToAttachments?.length
      ? await identities.resolve({ transport: "discord", externalId: message.replyAuthorId, principalId: null })
      : undefined;
    const replyImported = message.replyToMessageId && !storedReplyArtifacts.length && replyResolved
      ? await importDiscordAttachments(artifacts, message.replyToAttachments ?? [], replyResolved.principal.id, message.replyToMessageId, failure => {
        logger.write({ level: "warn", event: "discord.reply_attachment.import_failed", message: "Discord reply attachment could not be imported; continuing with the steer text", occurredAt: new Date().toISOString(), data: { messageId: message.messageId, replyToMessageId: message.replyToMessageId!, channelId: message.channelId, filename: failure.filename, reason: failure.reason, errorName: failure.error instanceof Error ? failure.error.name : "NonErrorThrown" } });
      })
      : { artifacts: [], promptSuffix: "" };
    const replyArtifacts = storedReplyArtifacts.length ? storedReplyArtifacts : replyImported.artifacts;
    const artifactIds = imported.map(artifact => artifact.id);
    const event = toInputEvent(message, artifactIds);
    const modelContent = await artifactModelContent(`[steer] [msg:${message.messageId} ${message.createdAt}] <@${message.authorId}>(${message.authorName ?? message.authorId}): ${message.content}${importedResult.promptSuffix}`, imported, profile.capabilities.includes("vision"), profile.protocol);
    const replyContent = message.replyToMessageId && (message.replyToContent !== undefined || replyArtifacts.length)
      ? await artifactModelContent(`[reply-target] [msg:${message.replyToMessageId} ${message.replyToCreatedAt ?? ""}] <@${message.replyAuthorId ?? "unknown"}>: ${message.replyToContent ?? "[內容無法取得；僅保留 Discord 訊息參照。]"}${replyImported.promptSuffix}`, replyArtifacts, profile.capabilities.includes("vision"), profile.protocol)
      : [];
    await ingress.steer({ event, runId: activeSession.runId, userContent: [...modelContent, ...replyContent] });
  });
  if (!accepted) return false;
  try { await accepted; return true; }
  catch (error) {
    logger.write({ level: "warn", event: "discord.steer.rejected", message: "Steer persistence failed; message falls back to the session queue", occurredAt: new Date().toISOString(), data: { messageId: message.messageId, errorName: error instanceof Error ? error.name : "NonErrorThrown" } });
    return false;
  }
});
discord.onMessage(message => activeWork.track(handleMessage(message)));
await controlPanel?.start();
scheduler.start();
readiness.scheduler = true;
const writeReadinessEvidence = () => writeFile(`${paths.state}/gateway.ready`, `${JSON.stringify({ pid: process.pid, startedAt: processStart, checks: readiness })}\n`, { mode: 0o600 });
connectDiscordFromSecrets = async () => {
  if (readiness.discord) return true;
  const token = process.env.DISCORD_TOKEN?.trim();
  const missing = [...(!token ? ["DISCORD_TOKEN"] : []), ...(!ownerDiscordId ? ["UMIRO_OWNER_DISCORD_ID"] : [])];
  readiness.configurationRequired = missing;
  if (missing.length > 0) { await writeReadinessEvidence(); return false; }
  if (discordStartAttempted) return false;
  discordStartAttempted = true;
  try {
    await discord.start(token!, discordPolicy.presence);
    const identity = discord.identity();
    if (identity) await completePendingRestart(pendingRestartFile, identity.tag).catch(error => logger.write({ level: "error", event: "discord.restart_completion_failed", message: "Restart completed but the Discord interaction could not be updated", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown", errorMessage: safeErrorMessage(error, runtimeSecrets()) } }));
    readiness.discord = true;
    readiness.configurationRequired = [];
    await delivery.drain();
    await writeReadinessEvidence();
    return true;
  } catch (error) {
    readiness.discord = false;
    readiness.configurationRequired = ["DISCORD_CONNECTION"];
    logger.write({ level: "error", event: "discord.start.failed", message: "Discord could not connect; Web UI remains available for configuration", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown", errorMessage: safeErrorMessage(error, runtimeSecrets()) } });
    await writeReadinessEvidence();
    return false;
  }
};
const discordConnected = await connectDiscordFromSecrets();
if (!discordConnected && !controlPanel) throw new Error(`Discord configuration is required: ${readiness.configurationRequired.join(", ")}`);
await writeReadinessEvidence();
let shuttingDown = false;
shutdown = async (exitCode = 0, restart = false) => {
  if (shuttingDown) return;
  shuttingDown = true;
  readiness.shuttingDown = true;
  readiness.scheduler = false;
  readiness.discord = false;
  scheduler.stop();
  embeddingWorker?.stop();
  clearInterval(pluginStateCleanupTimer);
  await controlPanel?.stop();
  await discord.stop();
  const drain = await activeWork.drain({
    timeoutMs: 30_000,
    cancellationGraceMs: 10_000,
    cancel: () => {
      const controllers = new Set([...activeRuns.values()].map(active => active.controller));
      for (const controller of controllers) controller.abort(new Error("gateway is shutting down"));
      return controllers.size;
    },
  });
  if (!drain.drained) logger.write({ level: "warn", event: "shutdown.inflight_abandoned", message: "In-flight work did not stop before the shutdown deadline", occurredAt: new Date().toISOString(), data: { activeWork: activeWork.size, cancelledRuns: drain.cancelled } });
  else await delivery.drain().catch(error => logger.write({ level: "warn", event: "shutdown.delivery_drain_failed", message: "Pending delivery drain failed during shutdown", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown" } }));
  if (drain.drained) store.close();
  await rm(`${paths.state}/gateway.ready`, { force: true });
  await releaseSingletonLock();
  if (restart && !process.env.INVOCATION_ID) {
    const entry = process.argv[1];
    if (!entry) throw new Error("gateway entry is unavailable for restart");
    const log = openSync(`${paths.state}/gateway.log`, "a", 0o600);
    const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
    if (!child.pid) throw new Error("gateway restart failed to spawn");
    await writeFile(`${paths.state}/gateway.pid.json`, `${JSON.stringify({ pid: child.pid, entry, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  }
  process.exit(restart && process.env.INVOCATION_ID ? 1 : exitCode);
};
if (restartRequested) void shutdown(0, true);
const fatal = (event: "unhandledRejection" | "uncaughtException", error: unknown) => {
  try { logger.write({ level: "error", event: `process.${event}`, message: "Fatal process error; shutting down cleanly", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown" } }); } catch { /* Last-resort handler must continue shutdown. */ }
  void shutdown(1);
};
process.once("unhandledRejection", error => fatal("unhandledRejection", error));
process.once("uncaughtException", error => fatal("uncaughtException", error));
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
