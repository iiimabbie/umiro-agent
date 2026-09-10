import { readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApprovalRunCoordinator, capabilities, ChildRunService, ContextEngine, ContextProviderRegistry, ExecutionStoreConflictError, HeadlessRecoveryCoordinator, HeadlessRunEngine, InteractiveIngress, PluginHookRegistry, PluginHost, ToolRegistry, ToolRuntime, intersectAuthority, type ConversationPreferences, type HeadlessRunResult, type JsonObject, type ModelCapability, type ReasoningEffort, type Run, type Step } from "@umiro/core";
import { decideDiscordIngress, DiscordDeliveryWorker, DiscordIdentityResolver, DiscordJsAdapter, parseDiscordTriggerPolicy, toInputEvent, type DiscordAdapterErrorContext, type DiscordApprovalAction, type DiscordButtonInteraction, type DiscordInteractionContext, type DiscordTriggerPolicyConfig } from "@umiro/adapter-discord";
import { OpenAIResponsesModel, callResponsesImageGeneration, callResponsesWebSearch } from "@umiro/model-openai";
import { SQLiteExecutionStore } from "@umiro/storage-sqlite";
import { FilePluginStateStore } from "./file-plugin-state.js";
import { loadPluginModule } from "./plugin-loader.js";
import { pluginStateDirectory } from "./plugin-composition.js";
import { umiroPaths } from "./paths.js";
import { EmbeddingWorker, HybridConversationSearch } from "./embedding-worker.js";
import { createConfiguredEmbedder, type EmbeddingConfig } from "./embedding-config.js";
import { DurableScheduler } from "./durable-scheduler.js";
import { ArtifactFileService } from "./artifact-files.js";
import { acquireSingletonLock } from "./singleton-lock.js";
import { SemanticRecallProvider } from "./semantic-recall.js";
import { JsonLineLogger } from "./structured-logger.js";
import { approvalDetails } from "./approval-presentation.js";
import { DiscordStreamingDelivery } from "./discord-streaming.js";
import { ControlPanelServer, validateControlConfig } from "./control-panel.js";
import { artifactModelContent } from "./artifact-input.js";
import { ActiveWorkTracker } from "./active-work.js";
import { SteerGate } from "./steer-gate.js";
import { summarizeModelUsage, type ModelPricing } from "./usage-summary.js";
import { observeExecutionStore, type CoreExecutionEventName } from "./execution-events.js";

const paths = umiroPaths();
const processStart = new Date().toISOString();
const readiness = { storage: false, plugins: false, discord: false, scheduler: false, shuttingDown: false };
const exec = promisify(execFile);
const releaseSingletonLock = await acquireSingletonLock(`${paths.state}/gateway.lock`);
try { process.loadEnvFile(paths.secrets); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
type ConfigModelProfile = { readonly model: string; readonly capabilities?: readonly ModelCapability[]; readonly reasoningEffort?: ReasoningEffort };
type RuntimeModelProfile = { readonly id: string; readonly model: string; readonly capabilities: readonly ModelCapability[]; readonly reasoningEffort?: ReasoningEffort };
const config = validateControlConfig(JSON.parse(await readFile(paths.configFile, "utf8"))) as unknown as { model: string; modelCapabilities?: readonly ModelCapability[]; profiles?: Record<string, ConfigModelProfile>; contextMaxTokens?: number; pricing?: Record<string, ModelPricing>; embedding?: EmbeddingConfig; discord?: DiscordTriggerPolicyConfig; webUi?: { enabled?: boolean; host?: string; port?: number }; plugins?: Array<{ path: string; config?: JsonObject }> };
const configuredProfiles = Object.fromEntries(Object.entries(config.profiles ?? {}).map(([id, profile]) => [id, { id, model: profile.model, capabilities: [...(profile.capabilities ?? [])], ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}) }])) as Record<string, RuntimeModelProfile>;
const defaultModelProfile: RuntimeModelProfile = { id: "default", model: config.model, capabilities: [...(config.modelCapabilities ?? [])] };
function resolveModelProfile(selection?: string): RuntimeModelProfile {
  if (!selection) return defaultModelProfile;
  return configuredProfiles[selection] ?? { id: selection, model: selection, capabilities: [] };
}
const allModelCapabilities = [...new Set([...(config.modelCapabilities ?? []), ...Object.values(configuredProfiles).flatMap(profile => profile.capabilities)])] as ModelCapability[];
const contextMaxTokens = config.contextMaxTokens ?? 24_000;
const discordPolicy = parseDiscordTriggerPolicy(config.discord);
const managedRaw = JSON.parse(await readFile(`${paths.config}/plugins.json`, "utf8").catch(() => "[]")) as Array<string | { path: string; enabled: boolean; config?: JsonObject }>;
const managed = managedRaw.map(item => typeof item === "string" ? { path: item, enabled: true } : item).filter(item => item.enabled);
const byPath = new Map<string, { path: string; config?: JsonObject }>();
for (const item of managed) byPath.set(item.path, { path: item.path, ...(item.config ? { config: item.config } : {}) });
for (const item of config.plugins ?? []) byPath.set(item.path, item);
const configured = [...byPath.values()];
const modules = await Promise.all(configured.map(item => loadPluginModule(item.path)));
const hostedWebSearch = allModelCapabilities.includes("hosted_web_search");
const hostedImageGeneration = allModelCapabilities.includes("hosted_image_generation");
const granted = capabilities("tool.catalog", ...(hostedWebSearch ? ["model.hosted_web_search"] : []), ...(hostedImageGeneration ? ["model.hosted_image_generation"] : []), ...modules.flatMap(module => module.manifest.permissions.capabilities));
const authority = { capabilities: granted, visibility: { kind: "all" as const }, instructionAuthority: "full" as const };
const tools = new ToolRegistry();
const providers = new ContextProviderRegistry();
const logger = new JsonLineLogger();
const pluginHooks = new PluginHookRegistry(logger);
let emitPluginEvent = async (_event: CoreExecutionEventName, _payload: JsonObject): Promise<void> => undefined;
const store = observeExecutionStore(new SQLiteExecutionStore(paths.sqlite), { emit: (event, payload) => emitPluginEvent(event, payload) });
const migratePluginState = async (namespace: string) => {
  const legacy = new FilePluginStateStore(pluginStateDirectory(paths.data, namespace));
  const target = store.pluginState(namespace);
  for (const entry of await legacy.list()) {
    if (await target.read(entry.key)) continue;
    const value = await legacy.read(entry.key);
    if (!value) continue;
    let expiresAt: string | undefined;
    if (namespace === "discord-tools" && entry.key.startsWith("buttons/")) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(value)) as { expiresAt?: unknown };
        if (typeof parsed.expiresAt === "string" && Number.isFinite(Date.parse(parsed.expiresAt))) expiresAt = parsed.expiresAt;
      } catch { /* Legacy opaque state remains importable without TTL metadata. */ }
    }
    await target.writeAtomic(entry.key, value, expiresAt ? { expiresAt } : undefined);
  }
};
const pluginStateNamespaces = new Set(["discord-tools", ...modules.map(module => module.manifest.namespace)]);
for (const namespace of pluginStateNamespaces) await migratePluginState(namespace);
const artifacts = new ArtifactFileService(paths.artifacts, store);
const cleanupExpiredPluginState = async (): Promise<void> => {
  const now = new Date().toISOString();
  const removed = (await Promise.all([...pluginStateNamespaces].map(namespace => store.pluginState(namespace).deleteExpired?.(now) ?? 0))).reduce((sum, count) => sum + count, 0);
  if (removed > 0) logger.write({ level: "debug", event: "plugin_state.expired_cleanup", message: "Expired Plugin state entries were removed", occurredAt: now, data: { removed } });
};
await cleanupExpiredPluginState();
const pluginStateCleanupTimer = setInterval(() => { void cleanupExpiredPluginState().catch(error => logger.write({ level: "warn", event: "plugin_state.expired_cleanup_failed", message: "Expired Plugin state cleanup failed", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown" } })); }, 60 * 60 * 1_000);
pluginStateCleanupTimer.unref?.();
const extractionBackfill = await artifacts.backfillTextExtractions();
if (extractionBackfill.updated > 0) await store.rebuildSearchProjection();
if (extractionBackfill.failed > 0) logger.write({ level: "warn", event: "artifact.extraction.backfill_degraded", message: "Some legacy artifact text could not be extracted", occurredAt: new Date().toISOString(), data: extractionBackfill });
const embedder = createConfiguredEmbedder(config.embedding);
const embeddingWorker = embedder ? new EmbeddingWorker(store, embedder, 15_000, logger) : undefined;
const search = new HybridConversationSearch(store, embedder, logger);
if (embedder) providers.register(new SemanticRecallProvider(store, embedder, () => new Date(), logger));
const scheduler = new DurableScheduler(store);
const legacyServices = {
  configDirectory: `${paths.config}/plugin-config`,
  async ask(prompt: string, options?: { systemPrompt?: string; maxTurns?: number; model?: string }) {
    const execution = { origin: { kind: "event" as const, pluginId: "legacy" }, actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, authority };
    const fullPrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    const runId = crypto.randomUUID(); const assembledContext = await contextEngine.assemble({ runId, execution, prompt: fullPrompt, maxCharacters: 100_000, maxTokens: contextMaxTokens });
    const result = await engine.run({ runId, context: execution, model: options?.model ?? config.model, prompt: fullPrompt, assembledContext, ...(options?.maxTurns ? { maxModelTurns: options.maxTurns } : {}) });
    if (result.status !== "succeeded") throw new Error(`legacy plugin agent Run ended ${result.status}`); return { text: result.text };
  },
  sendText: (input: { channelId: string; content: string }) => discord.sendText(input.channelId, input.content),
  editText: (input: { channelId: string; messageId: string; content: string }) => discord.editText(input.channelId, input.messageId, input.content),
};
let host: PluginHost;
const activeRuns = new Map<string, { readonly controller: AbortController; readonly userId: string }>();
const activeSessions = new Map<string, { readonly runId: string; readonly gate: SteerGate }>();
const activeWork = new ActiveWorkTracker();

const baseUrl = process.env.LLM_BASE_URL?.trim();
if (!baseUrl) throw new Error("LLM_BASE_URL is required");
const apiKey = process.env.LLM_API_KEY?.trim();
const modelPort = new OpenAIResponsesModel({ baseUrl, auth: apiKey ? "bearer" : "none", ...(apiKey ? { apiKey } : {}), timeoutMs: 120_000 });
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
const engine = new HeadlessRunEngine(modelPort, tools, store);
const contextEngine = new ContextEngine(providers);
const childRuns = new ChildRunService(engine, store);
const approvalRuns = new ApprovalRunCoordinator(store, engine);
await new HeadlessRecoveryCoordinator(store, engine).recoverAll();
await scheduler.recover();
readiness.storage = true;
const ownerDiscordId = process.env.UMIRO_OWNER_DISCORD_ID?.trim();
if (!ownerDiscordId) throw new Error("UMIRO_OWNER_DISCORD_ID is required");
const identities = new DiscordIdentityResolver(store, { ownerDiscordId, ownerAuthority: authority, memberAuthority: authority });
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
const discord = new DiscordJsAdapter();
await discord.setRespondToBots(discordPolicy.respondToBots === true);
const buttonState = store.pluginState("discord-tools");
discord.onButton(async (interaction: DiscordButtonInteraction) => {
    const key = `buttons/${interaction.buttonSetId}.json`;
    const current = await buttonState.readVersioned(key);
    if (!current) throw new Error("button set is unavailable or expired");
    const record = JSON.parse(new TextDecoder().decode(current.value)) as { channelId: string; allowedUserIds: string[]; expiresAt: string; usedButtonIds: string[]; buttons: Array<{ id: string; actionTool: string; actionArgs: JsonObject }> };
    if (record.channelId !== interaction.channelId) throw new Error("button channel does not match");
    if (Date.parse(record.expiresAt) <= Date.now()) { await buttonState.remove(key); throw new Error("button set expired"); }
    if (record.allowedUserIds.length > 0 && !record.allowedUserIds.includes(interaction.userId)) throw new Error("button user is not allowed");
    if (record.usedButtonIds.includes(interaction.buttonId)) throw new Error("button was already used");
    const action = record.buttons.find(button => button.id === interaction.buttonId);
    if (!action) throw new Error("button action does not exist");
    const actionDefinition = tools.get(action.actionTool);
    if (!actionDefinition) throw new Error("button action tool is unavailable");
    if (actionDefinition.policy.approvalRequirement === "required") throw new Error("button action requires the separate exact-operation approval flow");
    record.usedButtonIds.push(interaction.buttonId);
    const claimed = await buttonState.compareAndSwap(key, current.version, new TextEncoder().encode(JSON.stringify(record)), { expiresAt: record.expiresAt });
    if (!claimed.updated) throw new Error("button was already claimed");
    const resolved = await identities.resolve({ transport: "discord", externalId: interaction.userId, principalId: null });
    const now = new Date().toISOString(); const runId = crypto.randomUUID(); const stepId = crypto.randomUUID();
    const execution = { actor: resolved.principal, authority: resolved.authority, origin: { kind: "interactive" as const, transport: "discord", conversationId: interaction.channelId } };
    const run: Run = { id: runId, revision: 0, state: "queued", context: execution, resumeEligibility: "eligible", createdAt: now, updatedAt: now };
    const step: Step = { id: stepId, runId, revision: 0, sequence: 0, kind: "operation", state: "pending", createdAt: now, updatedAt: now };
    await store.createRunWithStep(run, step);
    await store.updateExecutionProgress({ runId, expectedRunRevision: 0, expectedRunState: "queued", runState: "running", resumeEligibility: "eligible", runUpdatedAt: now, step: { id: stepId, expectedRevision: 0, expectedState: "pending", state: "running", updatedAt: now } });
    const result = await new ToolRuntime(tools, store).execute({ toolName: action.actionTool, input: action.actionArgs, stepId, runId, context: execution, idempotencyKey: `button:${interaction.buttonSetId}:${interaction.buttonId}` });
    const terminal = result.status === "succeeded" ? "succeeded" : result.status === "approval_required" ? "waiting" : "failed";
    await store.updateExecutionProgress({ runId, expectedRunRevision: 1, expectedRunState: "running", runState: terminal, ...(terminal === "waiting" ? { waitingReason: "approval_required" } : {}), resumeEligibility: terminal === "waiting" ? "manual_review" : "not_applicable", runUpdatedAt: new Date().toISOString(), ...(terminal === "waiting" ? {} : { step: { id: stepId, expectedRevision: 1, expectedState: "running" as const, state: terminal === "succeeded" ? "succeeded" as const : "failed" as const, updatedAt: new Date().toISOString() } }) });
    return { content: result.status === "succeeded" ? `Action completed: ${action.actionTool}` : result.status === "approval_required" ? `Approval required: ${result.approvalId}` : `Action ${result.status}` };
});
discord.onError((error: unknown, context: DiscordAdapterErrorContext) => logger.write({ level: "error", event: `discord.${context.event}.failed`, message: "Discord event handler failed", occurredAt: new Date().toISOString(), data: { ...context, errorName: error instanceof Error ? error.name : "NonErrorThrown" } }));
const delivery = new DiscordDeliveryWorker(store, discord, () => new Date().toISOString(), store);
const webUiConfig = config.webUi ?? { enabled: false, host: "127.0.0.1", port: 3210 };
const controlPanel = webUiConfig.enabled === false ? undefined : new ControlPanelServer({ host: webUiConfig.host ?? "127.0.0.1", port: webUiConfig.port ?? 3210, token: process.env.UMIRO_WEB_UI_TOKEN?.trim() ?? "", configFile: paths.configFile, workspace: paths.workspace, schedules: {
  list: () => scheduler.list(),
  create: input => scheduler.create({ name: input.name, enabled: true, schedule: input.kind === "cron" ? { kind: "cron", expression: input.expression! } : { kind: "once", at: input.at! }, timezone: input.timezone, jobRef: "agent.prompt", input: { prompt: input.prompt }, creatorPrincipalId: "owner", creatorRoles: ["owner"], authority, ...(input.channelId ? { destination: { kind: "discord", channelId: input.channelId } } : {}), misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 15_000 }),
  setEnabled: (id, enabled) => scheduler.setEnabled(id, enabled),
  update: (id, input) => scheduler.update(id, { name: input.name, schedule: input.kind === "cron" ? { kind: "cron", expression: input.expression! } : { kind: "once", at: input.at! }, timezone: input.timezone, input: { prompt: input.prompt }, ...(input.channelId ? { destination: { kind: "discord", channelId: input.channelId } } : {}), misfirePolicy: "coalesce", maxAttempts: 3, retryBackoffMs: 15_000 }),
  remove: id => scheduler.remove(id),
}, plugins: {
  list: async () => JSON.parse(await readFile(`${paths.config}/plugins.json`, "utf8").catch(() => "[]")),
  run: async (action, source, workspace, pluginConfig) => {
    const args = ["plugin", action, source, ...(workspace ? ["--workspace", workspace] : []), ...(pluginConfig ? ["--config", JSON.stringify(pluginConfig)] : [])];
    const result = await exec(`${paths.root}/bin/umiro`, args, { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
    return { ok: true, output: result.stdout.trim(), restartRequired: true };
  },
}, approvals: {
  list: async () => Promise.all((await store.listPendingApprovals(100)).map(async approval => { const operation = await store.getOperation(approval.operationId); return { id: approval.id, operation: operation?.kind ?? "unknown", details: operation ? approvalDetails(operation) : "Operation missing", expiresAt: approval.expiresAt }; })),
  resolve: async (id, action) => {
    const outcome = await approvalRuns.resolveAndResume(id, action, { actor: { id: "owner", kind: "human", roles: ["owner"] }, authority, origin: { kind: "interactive", transport: "web-ui", conversationId: "control-panel" } });
    if (outcome.status === "resumed") { await delivery.drain(); return { approval: outcome.approval.state, runId: outcome.runId, runStatus: outcome.result.status }; }
    return { approval: outcome.approval.state, runId: outcome.runId, runStatus: outcome.runState };
  },
}, runs: {
  list: async (limit: number) => Promise.all((await store.listRuns(limit)).map(async run => { const output = await store.getRunOutput(run.id); return { id: run.id, state: run.state, origin: run.context.origin.kind, createdAt: run.createdAt, updatedAt: run.updatedAt, ...(output ? { usage: output.usage } : {}) }; })),
  get: async (id: string) => { const run = await store.getRun(id); if (!run) return undefined; return { run, steps: await store.listSteps(id), operations: await store.listOperations(id), modelCalls: await store.listModelCalls(id), output: await store.getRunOutput(id), audit: await store.listAuditEvents(id) }; },
}, logs: limit => logger.list(limit), usage: async () => { const runs = await store.listRuns(200); const calls = (await Promise.all(runs.map(run => store.listModelCalls(run.id)))).flat(); return { sampledRuns: runs.length, ...summarizeModelUsage(calls, config.pricing) }; }, runtime: () => ({ status: "running", pid: process.pid, startedAt: processStart, ready: readiness.storage && readiness.plugins && readiness.discord && readiness.scheduler && !readiness.shuttingDown, readiness, bot: discord.identity(), plugins: host?.list().map(item => ({ id: item.id, state: item.state })) ?? [] }), readiness: async () => ({ ...readiness, plugins: readiness.plugins && (await host.health()).every(item => item.status === "ok") }), processId: process.pid });
async function presentApproval(result: HeadlessRunResult, channelId: string): Promise<void> {
  if (result.status !== "waiting" || result.reason !== "approval_required") return;
  const approval = await store.getApproval(result.approvalId);
  if (!approval) throw new Error(`Approval is missing: ${result.approvalId}`);
  const operation = await store.getOperation(approval.operationId);
  if (!operation) throw new Error(`Approval operation is missing: ${approval.operationId}`);
  await discord.sendApproval(channelId, { approvalId: approval.id, operation: operation.kind, details: approvalDetails(operation), expiresAt: approval.expiresAt });
}
host = new PluginHost(tools, providers, authority, namespace => store.pluginState(namespace), pluginHooks, undefined, undefined, { conversationSearch: search, searchDocumentProjection: store, scheduler, childRuns, artifacts, discord, legacy: legacyServices }, undefined, logger);
for (let index = 0; index < modules.length; index++) await host.enable(modules[index]!, { config: configured[index]!.config ?? {} });
emitPluginEvent = (event, payload) => host.emitHook(event, payload);
await scheduler.syncPluginJobs(host.listJobs());
readiness.plugins = true;
embeddingWorker?.start();
scheduler.setDispatcher(async (trigger, occurrence, signal) => {
  if (trigger.jobRef.startsWith("plugin:")) { await host.runJob(trigger.jobRef.slice("plugin:".length), signal); return; }
  if (trigger.jobRef !== "agent.prompt" || typeof trigger.input.prompt !== "string") throw new Error(`unsupported scheduled job: ${trigger.jobRef}`);
  const execution = { origin: { kind: "schedule" as const, scheduleId: trigger.id }, actor: { id: trigger.creatorPrincipalId, kind: trigger.creatorRoles.includes("system") ? "system" as const : "human" as const, roles: trigger.creatorRoles }, authority: intersectAuthority(trigger.authority, authority) };
  const prompt = `[Authoritative current time: ${new Date().toISOString()}]\n[Scheduled task: ${trigger.name}; originally due ${occurrence.scheduledFor}]\n\n${trigger.input.prompt}`;
  const assembledContext = await contextEngine.assemble({ runId: occurrence.runId, execution, prompt, maxCharacters: 100_000, maxTokens: contextMaxTokens, ...(signal ? { signal } : {}) });
  const result = await engine.run({ runId: occurrence.runId, context: execution, model: typeof trigger.input.model === "string" ? trigger.input.model : config.model, prompt, assembledContext, ...(trigger.destination ? { deliveryDestination: trigger.destination } : {}), ...(signal ? { signal } : {}) });
  if (result.status !== "succeeded") throw new Error(`scheduled Run ${result.runId} ended ${result.status}`);
  await delivery.drain(signal);
});
const builtinCommands = [
  { name: "stop", description: "Cancel an active Run.", ownerOnly: false, ephemeral: true, options: [{ name: "run_id", description: "Run identifier", type: "string" as const, required: true }] },
  { name: "followup", description: "Send a follow-up turn to this conversation.", ownerOnly: false, ephemeral: true, options: [{ name: "prompt", description: "Follow-up message", type: "string" as const, required: true }] },
  { name: "archive", description: "Archive this conversation and start fresh on the next message.", ownerOnly: true, ephemeral: true },
  { name: "model", description: "Switch the model for this Discord session.", ownerOnly: true, ephemeral: true, options: [{ name: "name", description: "Model ID, or reset to use the global default.", type: "string" as const, required: true }, { name: "effort", description: "Reasoning effort.", type: "string" as const, required: false, choices: ["default", "low", "medium", "high", "xhigh"].map(value => ({ name: value, value })) }] },
  { name: "queue", description: "Set queue or steer mode for this Discord session.", ownerOnly: false, ephemeral: true, options: [{ name: "mode", description: "Message handling mode, or reset for the global default.", type: "string" as const, required: true, choices: ["queue", "steer", "reset"].map(value => ({ name: value, value })) }] },
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
  if (name === "followup") {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt is required");
    const messageId = `command-${crypto.randomUUID()}`;
    const event = toInputEvent({ messageId, channelId: commandContext.channelId, ...(commandContext.guildId ? { guildId: commandContext.guildId } : {}), authorId: commandContext.userId, content: prompt, createdAt: new Date().toISOString() });
    const controller = new AbortController();
    let runId = event.id;
    const active = { controller, userId: commandContext.userId };
    const streaming = new DiscordStreamingDelivery(commandContext.channelId, discord, store, Date.now, error => logger.write({ level: "warn", event: "discord.streaming.degraded", message: "Discord streaming failed; durable delivery remains pending", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown" } }));
    activeRuns.set(runId, active);
    try {
      const profile = await sessionProfile(commandContext.channelId);
      const result = await ingress.handle({ event, model: profile.model, modelProfile: { id: profile.id, model: profile.model, capabilities: profile.capabilities, reasoningEffort: profile.reasoningEffort }, reasoningEffort: profile.reasoningEffort, maxContextCharacters: 100_000, maxContextTokens: contextMaxTokens, deliveryDestination: { kind: "discord", channelId: commandContext.channelId }, signal: controller.signal, onTextDelta: delta => streaming.delta(delta), onRunCreated: id => { runId = id; activeRuns.set(id, active); } });
      if (result.status === "executed") await presentApproval(result.result, commandContext.channelId);
      if (result.status === "executed" && result.result.status === "succeeded") await streaming.finalize(result.result.deliveryId, result.result.text, new Date().toISOString());
      await delivery.drain(controller.signal);
      return { conversationId: result.conversationId, turnId: result.turnId, runId: result.status === "duplicate" ? result.runId : result.result.runId, status: result.status };
    } finally { activeRuns.delete(runId); activeRuns.delete(event.id); }
  }
  if (name === "archive") {
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
    return { model: updated.model ?? config.model, reasoningEffort: updated.reasoningEffort ?? "default", source: updated.model ? "session" : "global" };
  }
  if (name === "queue") {
    const mode = String(input.mode ?? "");
    if (mode !== "queue" && mode !== "steer" && mode !== "reset") throw new TypeError("queue mode must be queue, steer, or reset");
    const updated = await updateSessionPreferences(commandContext.channelId, current => ({ ...(current?.model ? { model: current.model, reasoningEffort: current.reasoningEffort! } : {}), ...(mode === "reset" ? {} : { queueMode: mode }) }));
    return { queueMode: updated.queueMode ?? discordPolicy.queueMode ?? "queue", source: updated.queueMode ? "session" : "global" };
  }
  const command = host.listCommands().find(candidate => candidate.name === name);
  if (!command) throw new Error(`plugin command not found: ${name}`);
  if (command.ownerOnly !== false && commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
  return host.executeCommand(name, input, commandContext);
};
discord.onCommand([...host.listCommands(), ...builtinCommands], (name: string, input: Record<string, string | number | boolean>, commandContext: { userId: string; channelId: string; guildId?: string }) => activeWork.track(handleCommand(name, input, commandContext)));
const handleApproval = async (approvalId: string, action: DiscordApprovalAction, interaction: DiscordInteractionContext) => {
  const resolved = await identities.resolve({ transport: "discord", externalId: interaction.userId, principalId: null });
  const outcome = await approvalRuns.resolveAndResume(approvalId, action, { actor: resolved.principal, authority: resolved.authority, origin: { kind: "interactive", transport: "discord", conversationId: interaction.channelId } });
  if (outcome.status === "resumed") {
    await presentApproval(outcome.result, interaction.channelId);
    await delivery.drain();
    const state = outcome.result.status === "succeeded" ? "completed" : outcome.result.status;
    return { content: `Approval ${outcome.approval.state}; Run ${state}.` };
  }
  return { content: `Approval ${outcome.approval.state}; Run is already ${outcome.runState}.` };
};
discord.onApproval((approvalId: string, action: DiscordApprovalAction, interaction: DiscordInteractionContext) => activeWork.track(handleApproval(approvalId, action, interaction)));
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
  await discord.sendTyping(message.channelId);
  const profile = await sessionProfile(message.channelId);
  const artifactIds: string[] = [];
  const importedArtifacts = [];
  for (const attachment of message.attachments ?? []) {
    const resolved = await identities.resolve({ transport: "discord", externalId: message.authorId, principalId: null });
    const artifact = await artifacts.importDiscord(attachment, resolved.principal.id, message.messageId);
    artifactIds.push(artifact.id);
    importedArtifacts.push(artifact);
  }
  const controller = new AbortController();
  const gate = new SteerGate();
  const event = toInputEvent(message, artifactIds);
  const userContent = await artifactModelContent(message.content, importedArtifacts, profile.capabilities.includes("vision"));
  let runKey = event.id;
  const active = { controller, userId: message.authorId };
  const streaming = new DiscordStreamingDelivery(message.channelId, discord, store, Date.now, error => logger.write({ level: "warn", event: "discord.streaming.degraded", message: "Discord streaming failed; durable delivery remains pending", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown" } }));
  const execution = ingress.handle({ event, model: profile.model, modelProfile: { id: profile.id, model: profile.model, capabilities: profile.capabilities, reasoningEffort: profile.reasoningEffort }, reasoningEffort: profile.reasoningEffort, ...(userContent.length ? { userContent } : {}), maxContextCharacters: 100_000, maxContextTokens: contextMaxTokens, deliveryDestination: { kind: "discord", channelId: message.channelId }, signal: controller.signal, onTextDelta: delta => streaming.delta(delta), steerControl: gate, onRunCreated: id => { runKey = id; activeRuns.set(id, active); activeSessions.set(event.conversation.externalId, { runId: id, gate }); } });
  activeRuns.set(runKey, active);
  let result;
  try { result = await execution; } finally { activeRuns.delete(runKey); activeRuns.delete(event.id); if (activeSessions.get(event.conversation.externalId)?.runId === runKey) activeSessions.delete(event.conversation.externalId); }
  if (result.status === "executed") await presentApproval(result.result, message.channelId);
  if (result.status === "executed" && result.result.status === "succeeded") await streaming.finalize(result.result.deliveryId, result.result.text, new Date().toISOString());
  await delivery.drain();
};
discord.onSteer(async message => {
  const activeSession = activeSessions.get(message.threadId ?? message.channelId);
  if (!activeSession) return false;
  const decision = decideDiscordIngress({ channelId: message.channelId, ...(message.guildId ? { guildId: message.guildId } : {}), authorId: message.authorId, authorBot: message.authorBot === true, botMentioned: message.botMentioned === true, replyToBot: message.replyToBot === true }, { ...discordPolicy, respondToBots: discord.respondsToBots() }, ownerDiscordId);
  if (decision.disposition !== "trigger" || (await sessionProfile(message.threadId ?? message.channelId)).queueMode !== "steer") return false;
  const accepted = activeSession.gate.submit(async () => {
    const profile = await sessionProfile(message.threadId ?? message.channelId);
    const resolved = await identities.resolve({ transport: "discord", externalId: message.authorId, principalId: null });
    const imported = [];
    const artifactIds: string[] = [];
    for (const attachment of message.attachments ?? []) { const artifact = await artifacts.importDiscord(attachment, resolved.principal.id, message.messageId); imported.push(artifact); artifactIds.push(artifact.id); }
    const event = toInputEvent(message, artifactIds);
    const modelContent = await artifactModelContent(`[Discord user ${message.authorName ?? message.authorId} (${message.authorId}) added:]\n${message.content}`, imported, profile.capabilities.includes("vision"));
    await ingress.steer({ event, runId: activeSession.runId, userContent: modelContent });
  });
  if (!accepted) return false;
  try { await accepted; return true; }
  catch (error) {
    logger.write({ level: "warn", event: "discord.steer.rejected", message: "Steer persistence failed; message falls back to the session queue", occurredAt: new Date().toISOString(), data: { messageId: message.messageId, errorName: error instanceof Error ? error.name : "NonErrorThrown" } });
    return false;
  }
});
discord.onMessage(message => activeWork.track(handleMessage(message)));
const token = process.env.DISCORD_TOKEN?.trim();
if (!token) throw new Error("DISCORD_TOKEN is required");
await controlPanel?.start();
await discord.start(token, discordPolicy.presence);
readiness.discord = true;
await delivery.drain();
scheduler.start();
readiness.scheduler = true;
await writeFile(`${paths.state}/gateway.ready`, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), checks: readiness })}\n`, { mode: 0o600 });
let shuttingDown = false;
const shutdown = async (exitCode = 0) => {
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
  process.exit(exitCode);
};
const fatal = (event: "unhandledRejection" | "uncaughtException", error: unknown) => {
  try { logger.write({ level: "error", event: `process.${event}`, message: "Fatal process error; shutting down cleanly", occurredAt: new Date().toISOString(), data: { errorName: error instanceof Error ? error.name : "NonErrorThrown" } }); } catch { /* Last-resort handler must continue shutdown. */ }
  void shutdown(1);
};
process.once("unhandledRejection", error => fatal("unhandledRejection", error));
process.once("uncaughtException", error => fatal("uncaughtException", error));
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
