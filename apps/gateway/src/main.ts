import { readFile, rm, writeFile } from "node:fs/promises";
import { capabilities, ChildRunService, ContextEngine, ContextProviderRegistry, HeadlessRecoveryCoordinator, HeadlessRunEngine, InteractiveIngress, PluginHookRegistry, PluginHost, ToolRegistry, intersectAuthority, type JsonObject } from "@umiro/core";
import { DiscordDeliveryWorker, DiscordIdentityResolver, DiscordJsAdapter, toInputEvent } from "@umiro/adapter-discord";
import { OpenAIResponsesModel } from "@umiro/model-openai";
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

const paths = umiroPaths();
const releaseSingletonLock = await acquireSingletonLock(`${paths.state}/gateway.lock`);
try { process.loadEnvFile(paths.secrets); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const config = JSON.parse(await readFile(paths.configFile, "utf8")) as { model: string; embedding?: EmbeddingConfig; plugins?: Array<{ path: string; config?: JsonObject }> };
const managedRaw = JSON.parse(await readFile(`${paths.config}/plugins.json`, "utf8").catch(() => "[]")) as Array<string | { path: string; enabled: boolean; config?: JsonObject }>;
const managed = managedRaw.map(item => typeof item === "string" ? { path: item, enabled: true } : item).filter(item => item.enabled);
const byPath = new Map<string, { path: string; config?: JsonObject }>();
for (const item of managed) byPath.set(item.path, { path: item.path, ...(item.config ? { config: item.config } : {}) });
for (const item of config.plugins ?? []) byPath.set(item.path, item);
const configured = [...byPath.values()];
const modules = await Promise.all(configured.map(item => loadPluginModule(item.path)));
const granted = capabilities(...modules.flatMap(module => module.manifest.permissions.capabilities));
const authority = { capabilities: granted, visibility: { kind: "all" as const }, instructionAuthority: "full" as const };
const tools = new ToolRegistry();
const providers = new ContextProviderRegistry();
const store = new SQLiteExecutionStore(paths.sqlite);
const artifacts = new ArtifactFileService(paths.artifacts, store);
const embedder = createConfiguredEmbedder(config.embedding);
const embeddingWorker = embedder ? new EmbeddingWorker(store, embedder) : undefined;
const search = new HybridConversationSearch(store, embedder);
if (embedder) providers.register(new SemanticRecallProvider(store, embedder));
const scheduler = new DurableScheduler(store);
const logger = new JsonLineLogger();
const pluginHooks = new PluginHookRegistry(logger);
const legacyServices = {
  configDirectory: `${paths.config}/plugin-config`,
  async ask(prompt: string, options?: { systemPrompt?: string; maxTurns?: number; model?: string }) {
    const execution = { origin: { kind: "event" as const, pluginId: "legacy" }, actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, authority };
    const fullPrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    const runId = crypto.randomUUID(); const assembledContext = await contextEngine.assemble({ runId, execution, prompt: fullPrompt, maxCharacters: 100_000 });
    const result = await engine.run({ runId, context: execution, model: options?.model ?? config.model, prompt: fullPrompt, assembledContext, ...(options?.maxTurns ? { maxModelTurns: options.maxTurns } : {}) });
    if (result.status !== "succeeded") throw new Error(`legacy plugin agent Run ended ${result.status}`); return { text: result.text };
  },
  sendText: (input: { channelId: string; content: string }) => discord.sendText(input.channelId, input.content),
  editText: (input: { channelId: string; messageId: string; content: string }) => discord.editText(input.channelId, input.messageId, input.content),
};
let host: PluginHost;
const activeRuns = new Map<string, { readonly controller: AbortController; readonly userId: string }>();

const baseUrl = process.env.LLM_BASE_URL?.trim();
if (!baseUrl) throw new Error("LLM_BASE_URL is required");
const apiKey = process.env.LLM_API_KEY?.trim();
const modelPort = new OpenAIResponsesModel({ baseUrl, auth: apiKey ? "bearer" : "none", ...(apiKey ? { apiKey } : {}), timeoutMs: 120_000 });
const engine = new HeadlessRunEngine(modelPort, tools, store);
const contextEngine = new ContextEngine(providers);
const childRuns = new ChildRunService(engine, store);
await new HeadlessRecoveryCoordinator(store, engine).recoverAll();
await scheduler.recover();
const ownerDiscordId = process.env.UMIRO_OWNER_DISCORD_ID?.trim();
if (!ownerDiscordId) throw new Error("UMIRO_OWNER_DISCORD_ID is required");
const identities = new DiscordIdentityResolver(store, { ownerDiscordId, ownerAuthority: authority, memberAuthority: authority });
const ingress = new InteractiveIngress(identities, store, store, contextEngine, engine);
const discord = new DiscordJsAdapter();
const delivery = new DiscordDeliveryWorker(store, discord, () => new Date().toISOString(), store);
host = new PluginHost(tools, providers, authority, namespace => new FilePluginStateStore(pluginStateDirectory(paths.data, namespace)), pluginHooks, undefined, undefined, { conversationSearch: search, scheduler, childRuns, legacy: legacyServices });
for (let index = 0; index < modules.length; index++) await host.enable(modules[index]!, { config: configured[index]!.config ?? {} });
await scheduler.syncPluginJobs(host.listJobs());
embeddingWorker?.start();
scheduler.setDispatcher(async (trigger, occurrence, signal) => {
  if (trigger.jobRef.startsWith("plugin:")) { await host.runJob(trigger.jobRef.slice("plugin:".length), signal); return; }
  if (trigger.jobRef !== "agent.prompt" || typeof trigger.input.prompt !== "string") throw new Error(`unsupported scheduled job: ${trigger.jobRef}`);
  const execution = { origin: { kind: "schedule" as const, scheduleId: trigger.id }, actor: { id: trigger.creatorPrincipalId, kind: trigger.creatorRoles.includes("system") ? "system" as const : "human" as const, roles: trigger.creatorRoles }, authority: intersectAuthority(trigger.authority, authority) };
  const prompt = `[Authoritative current time: ${new Date().toISOString()}]\n[Scheduled task: ${trigger.name}; originally due ${occurrence.scheduledFor}]\n\n${trigger.input.prompt}`;
  const assembledContext = await contextEngine.assemble({ runId: occurrence.runId, execution, prompt, maxCharacters: 100_000, ...(signal ? { signal } : {}) });
  const result = await engine.run({ runId: occurrence.runId, context: execution, model: typeof trigger.input.model === "string" ? trigger.input.model : config.model, prompt, assembledContext, ...(trigger.destination ? { deliveryDestination: trigger.destination } : {}), ...(signal ? { signal } : {}) });
  if (result.status !== "succeeded") throw new Error(`scheduled Run ${result.runId} ended ${result.status}`);
  await delivery.drain(signal);
});
const builtinCommands = [
  { name: "stop", description: "Cancel an active Run.", ownerOnly: false, ephemeral: true, options: [{ name: "run_id", description: "Run identifier", type: "string" as const, required: true }] },
  { name: "followup", description: "Send a follow-up turn to this conversation.", ownerOnly: false, ephemeral: true, options: [{ name: "prompt", description: "Follow-up message", type: "string" as const, required: true }] },
  { name: "archive", description: "Archive this conversation and start fresh on the next message.", ownerOnly: true, ephemeral: true },
];
discord.onCommand([...host.listCommands(), ...builtinCommands], async (name: string, input: Record<string, string | number | boolean>, commandContext: { userId: string; channelId: string; guildId?: string }) => {
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
    activeRuns.set(runId, active);
    try {
      const result = await ingress.handle({ event, model: config.model, maxContextCharacters: 100_000, deliveryDestination: { kind: "discord", channelId: commandContext.channelId }, signal: controller.signal, onRunCreated: id => { runId = id; activeRuns.set(id, active); } });
      await delivery.drain(controller.signal);
      return { conversationId: result.conversationId, turnId: result.turnId, runId: result.status === "duplicate" ? result.runId : result.result.runId, status: result.status };
    } finally { activeRuns.delete(runId); activeRuns.delete(event.id); }
  }
  if (name === "archive") {
    if (commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
    const archived = await store.archiveBoundConversation("discord", commandContext.channelId, new Date().toISOString());
    return archived ? { archived: true, conversationId: archived.id } : { archived: false, reason: "no_active_conversation" };
  }
  const command = host.listCommands().find(candidate => candidate.name === name);
  if (!command) throw new Error(`plugin command not found: ${name}`);
  if (command.ownerOnly !== false && commandContext.userId !== ownerDiscordId) throw new Error("Owner only");
  return host.executeCommand(name, input, commandContext);
});
discord.onMessage(async message => {
  await discord.sendTyping(message.channelId);
  const artifactIds: string[] = [];
  for (const attachment of message.attachments ?? []) {
    const resolved = await identities.resolve({ transport: "discord", externalId: message.authorId, principalId: null });
    const artifact = await artifacts.importDiscord(attachment, resolved.principal.id, message.messageId);
    artifactIds.push(artifact.id);
  }
  const controller = new AbortController();
  const event = toInputEvent(message, artifactIds);
  let runKey = event.id;
  const active = { controller, userId: message.authorId };
  const execution = ingress.handle({ event, model: config.model, maxContextCharacters: 100_000, deliveryDestination: { kind: "discord", channelId: message.channelId }, signal: controller.signal, onRunCreated: id => { runKey = id; activeRuns.set(id, active); } });
  activeRuns.set(runKey, active);
  try { await execution; } finally { activeRuns.delete(runKey); activeRuns.delete(event.id); }
  await delivery.drain();
});
const token = process.env.DISCORD_TOKEN?.trim();
if (!token) throw new Error("DISCORD_TOKEN is required");
await discord.start(token);
await delivery.drain();
await writeFile(`${paths.state}/gateway.ready`, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
scheduler.start();
const shutdown = async () => { scheduler.stop(); embeddingWorker?.stop(); await discord.stop(); store.close(); await rm(`${paths.state}/gateway.ready`, { force: true }); await releaseSingletonLock(); process.exit(0); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
