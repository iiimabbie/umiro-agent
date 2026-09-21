import { isInstructionAuthorityAtMost, type Authority } from "../authorization/authority.js";
import { ContextProviderRegistry } from "../context/registry.js";
import type { ContextProvider } from "../context/contract.js";
import { ToolRegistry } from "../tool/registry.js";
import type { DiscordPluginService, LoadedPlugin, PluginEnableOptions, PluginHealth, PluginHostServices, PluginInstance, PluginManifestV0, PluginModule, PluginLogger, TurnAnalysis, TurnAnalyzer, TurnAnalyzerInput } from "./contract.js";
import { NOOP_LOGGER, type StructuredLogger } from "../observability/logger.js";
import { validatePluginConfig, validatePluginManifest } from "./manifest.js";
import type { PluginStateStore } from "./state.js";
import { PluginHookRegistry } from "./hooks.js";
import { PluginCommandRegistry, PluginControlPanelViewRegistry, PluginJobRegistry, SkillRegistry, SubagentProfileRegistry } from "./contributions.js";

interface ActivePlugin {
  readonly manifest: PluginManifestV0;
  readonly instance: PluginInstance;
  state: LoadedPlugin["state"];
  error?: string;
}

function exactContributionSet(actual: readonly string[], declared: readonly string[] | undefined, label: string): void {
  const expected = [...(declared ?? [])].sort();
  const received = [...actual].sort();
  if (expected.length !== received.length || expected.some((value, index) => value !== received[index])) {
    throw new TypeError(`${label} do not match the plugin manifest`);
  }
}

function providerWithinCeiling(provider: ContextProvider, manifest: PluginManifestV0): ContextProvider {
  if (provider.requiredCapability && !manifest.permissions.capabilities.includes(provider.requiredCapability)) {
    throw new TypeError(`context provider ${provider.id} requires undeclared capability ${provider.requiredCapability}`);
  }
  return {
    ...provider,
    async load(request) {
      const blocks = await provider.load(request);
      for (const block of blocks) {
        if (!isInstructionAuthorityAtMost(block.instructionAuthority, manifest.permissions.instructionAuthority)) {
          throw new TypeError(`context provider ${provider.id} returned a block outside its plugin permission ceiling`);
        }
      }
      return blocks;
    },
  };
}

function manifestPolicyProvider(manifest: PluginManifestV0): ContextProvider | undefined {
  const policy = manifest.contributes.policy?.map(item => item.trim()).filter(Boolean);
  if (!policy?.length) return undefined;
  const id = `${manifest.id}.policy`;
  const content = `[Plugin policy: ${manifest.id}@${manifest.version}]\n${policy.map(item => `- ${item}`).join("\n")}`;
  return {
    id,
    role: "plugin-policy",
    priority: 350,
    async load() {
      return [{ id: `${id}:manifest`, providerId: id, role: "plugin-policy", content, source: { kind: "plugin-manifest-policy", ref: `${manifest.id}@${manifest.version}` }, influence: "instruction", instructionAuthority: "scoped", retention: "normal" }];
    },
  };
}

function skillInstructionProvider(manifest: PluginManifestV0, skill: import("./contract.js").SkillDefinition): ContextProvider | undefined {
  if (!skill.instructions.trim()) return undefined;
  const id = `${manifest.id}.skill.${skill.id}`;
  return { id, role: "skill-instructions", priority: 360, async load() { return [{ id: `${id}:instructions`, providerId: id, role: "skill-instructions", content: `[Skill instructions: ${skill.id}]\n${skill.instructions.trim()}`, source: { kind: "plugin-skill-instructions", ref: `${manifest.id}@${manifest.version}` }, influence: "instruction", instructionAuthority: "scoped", retention: "normal" }]; } };
}

function turnAnalyzerWithinCeiling(analyzer: TurnAnalyzer): TurnAnalyzer {
  return {
    id: analyzer.id,
    async analyze(input) {
      const result = await analyzer.analyze(input);
      if (result === undefined) return undefined;
      if (typeof result.shouldReply !== "boolean" || !Array.isArray(result.selectedToolNames) || result.selectedToolNames.some(name => typeof name !== "string") || new Set(result.selectedToolNames).size !== result.selectedToolNames.length || !Array.isArray(result.contextBlocks)) {
        throw new TypeError(`turn analyzer ${analyzer.id} returned an invalid result`);
      }
      const blocks = result.contextBlocks.map(block => {
        if (!block || block.influence !== "information" || block.instructionAuthority !== "none") throw new TypeError(`turn analyzer ${analyzer.id} returned a non-advisory context block`);
        if (block.providerId !== analyzer.id) throw new TypeError(`turn analyzer ${analyzer.id} returned a context block for another provider`);
        return { ...block, influence: "information" as const, instructionAuthority: "none" as const };
      });
      return { shouldReply: result.shouldReply, selectedToolNames: result.selectedToolNames, contextBlocks: blocks };
    },
  };
}

function redact(value: import("../ports/json.js").JsonValue, secrets: readonly string[], key?: string): import("../ports/json.js").JsonValue {
  if (key && /(secret|token|password|authorization|api.?key)/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return secrets.reduce((result, secret) => secret ? result.split(secret).join("[REDACTED]") : result, value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, secrets, name)]));
  return value;
}

function pluginLogger(base: StructuredLogger, pluginId: string, namespace: string, secrets: readonly string[]): PluginLogger {
  const write = (level: "debug" | "info" | "warn" | "error", event: string, message: string, data?: import("../ports/json.js").JsonObject) => {
    try { base.write({ level, event: `plugin.${namespace}.${event}`, message, occurredAt: new Date().toISOString(), pluginId, ...(data ? { data: redact(data, secrets) as import("../ports/json.js").JsonObject } : {}) }); } catch { /* logging must not alter plugin behavior */ }
  };
  return { debug: (e, m, d) => write("debug", e, m, d), info: (e, m, d) => write("info", e, m, d), warn: (e, m, d) => write("warn", e, m, d), error: (e, m, d) => write("error", e, m, d) };
}

function discordWithinCeiling(service: DiscordPluginService, manifest: PluginManifestV0): DiscordPluginService {
  const requireCapability = (capability: string) => {
    if (!manifest.permissions.capabilities.includes(capability)) throw new Error(`plugin ${manifest.id} requires undeclared service capability ${capability}`);
  };
  return {
    async createButtonSet(input) { requireCapability("discord.button.write"); return service.createButtonSet(input); },
    async sendButtons(input) { requireCapability("discord.button.write"); return service.sendButtons(input); },
    async sendMessage(input) { requireCapability("discord.message.write"); return service.sendMessage(input); },
    async react(input) { requireCapability("discord.message.react"); return service.react(input); },
    async pin(input) { requireCapability("discord.message.pin"); return service.pin(input); },
    async unpin(input) { requireCapability("discord.message.pin"); return service.unpin(input); },
    async fetchMessage(input) { requireCapability("discord.message.read"); return service.fetchMessage(input); },
    async createThread(input) { requireCapability("discord.thread.write"); return service.createThread(input); },
    async createForumPost(input) { requireCapability("discord.thread.write"); return service.createForumPost(input); },
    async archiveThread(input) { requireCapability("discord.thread.write"); return service.archiveThread(input); },
    async deleteThread(input) { requireCapability("discord.thread.delete"); return service.deleteThread(input); },
    async editMessage(input) { requireCapability("discord.message.write"); return service.editMessage(input); },
    async deleteMessage(input) { requireCapability("discord.message.delete"); return service.deleteMessage(input); },
    async fetchChannelMessages(input) { requireCapability("discord.message.read"); return service.fetchChannelMessages(input); },
    async setRespondToBots(enabled) { requireCapability("discord.policy.write"); return service.setRespondToBots(enabled); },
  };
}

export class PluginHost {
  private readonly plugins = new Map<string, ActivePlugin>();
  private turnAnalyzer: { readonly pluginId: string; readonly analyzer: TurnAnalyzer } | undefined;

  constructor(
    private readonly tools: ToolRegistry,
    private readonly contextProviders: ContextProviderRegistry,
    private readonly hostAuthorityCeiling: Authority,
    private readonly stateForNamespace?: (namespace: string) => PluginStateStore,
    private readonly hooks = new PluginHookRegistry(),
    private readonly jobs = new PluginJobRegistry(),
    private readonly commands = new PluginCommandRegistry(),
    private readonly services: PluginHostServices = {},
    private readonly skills = new SkillRegistry(),
    private readonly subagentProfiles = new SubagentProfileRegistry(),
    private readonly modelProfiles: { has(id: string): boolean } = { has: () => true },
    private readonly logger: StructuredLogger = NOOP_LOGGER,
    private readonly controlPanelViews = new PluginControlPanelViewRegistry(),
  ) {}

  async enable(module: PluginModule, options: PluginEnableOptions = {}): Promise<void> {
    const { manifest } = module;
    validatePluginManifest(manifest, this.hostAuthorityCeiling);
    if (this.plugins.has(manifest.id)) throw new Error(`plugin already loaded: ${manifest.id}`);

    const config = structuredClone(options.config ?? {});
    validatePluginConfig(manifest, config);
    const requiredSecrets = new Set(manifest.requiredSecrets ?? []);
    const allowedSecrets = new Set([...requiredSecrets, ...(manifest.optionalSecrets ?? [])]);
    for (const secret of requiredSecrets) {
      if (!options.secrets?.[secret]) throw new TypeError(`plugin ${manifest.id} requires secret ${secret}`);
    }

    const { searchDocumentProjection, ...runtimeServices } = this.services;
    const active: ActivePlugin = {
      manifest,
      instance: await module.create({
        pluginId: manifest.id,
        namespace: manifest.namespace,
        permissionCeiling: manifest.permissions,
        config,
        ...(this.stateForNamespace ? { state: this.stateForNamespace(manifest.namespace) } : {}),
        services: {
          ...runtimeServices,
          ...(runtimeServices.discord ? { discord: discordWithinCeiling(runtimeServices.discord, manifest) } : {}),
          subagentProfiles: this.subagentProfiles,
          ...(searchDocumentProjection ? { searchDocuments: {
            replaceSource: (sourceId, documents) => searchDocumentProjection.replaceSearchSource(manifest.namespace, sourceId, documents),
            removeSource: sourceId => searchDocumentProjection.removeSearchSource(manifest.namespace, sourceId),
          } } : {}),
        },
        logger: pluginLogger(this.logger, manifest.id, manifest.namespace, Object.values(options.secrets ?? {})),
        getSecret: name => allowedSecrets.has(name) ? options.secrets?.[name] : undefined,
      }),
      state: "starting",
    };
    this.plugins.set(manifest.id, active);

    const toolNames = active.instance.contributions.tools?.map(tool => tool.name) ?? [];
    const providerIds = active.instance.contributions.contextProviders?.map(provider => provider.id) ?? [];
    const turnAnalyzerIds = active.instance.contributions.turnAnalyzers?.map(analyzer => analyzer.id) ?? [];
    const hookIds = active.instance.contributions.hooks?.map(hook => hook.id) ?? [];
    const jobIds = active.instance.contributions.jobs?.map(job => job.id) ?? [];
    const commandIds = active.instance.contributions.commands?.map(command => command.name) ?? [];
    const skillIds = active.instance.contributions.skills?.map(skill => skill.id) ?? [];
    const controlPanelViewIds = active.instance.contributions.controlPanelViews?.map(view => view.id) ?? [];
    const registeredTools: string[] = [];
    const registeredProviders: string[] = [];
    let registeredTurnAnalyzer = false;
    const registeredHooks: string[] = [];
    const registeredJobs: string[] = [];
    const registeredCommands: string[] = [];
    const registeredSkills: string[] = [];
    const registeredSkillProviders: string[] = [];
    const registeredControlPanelViews: string[] = [];
    const registeredSubagentProfiles: string[] = [];
    const policyProvider = manifestPolicyProvider(manifest);
    try {
      exactContributionSet(toolNames, manifest.contributes.tools, `plugin ${manifest.id} tools`);
      exactContributionSet(providerIds, manifest.contributes.contextProviders, `plugin ${manifest.id} context providers`);
      exactContributionSet(turnAnalyzerIds, manifest.contributes.turnAnalyzers, `plugin ${manifest.id} turn analyzers`);
      if (turnAnalyzerIds.length > 1) throw new TypeError(`plugin ${manifest.id} may contribute at most one turn analyzer`);
      if (turnAnalyzerIds.length && this.turnAnalyzer) throw new Error(`duplicate turn analyzer: ${turnAnalyzerIds[0]}`);
      exactContributionSet(hookIds, manifest.contributes.hooks, `plugin ${manifest.id} hooks`);
      exactContributionSet(jobIds, manifest.contributes.jobs, `plugin ${manifest.id} jobs`);
      exactContributionSet(commandIds, manifest.contributes.commands, `plugin ${manifest.id} commands`);
      exactContributionSet(skillIds, manifest.contributes.skills, `plugin ${manifest.id} skills`);
      exactContributionSet(controlPanelViewIds, manifest.contributes.controlPanelViews, `plugin ${manifest.id} control panel views`);
      for (const tool of active.instance.contributions.tools ?? []) {
        if (!manifest.permissions.capabilities.includes(tool.policy.capability)) {
          throw new TypeError(`tool ${tool.name} requires undeclared capability ${tool.policy.capability}`);
        }
      }
      await active.instance.start?.();
      for (const tool of active.instance.contributions.tools ?? []) {
        this.tools.register(tool);
        registeredTools.push(tool.name);
      }
      for (const provider of active.instance.contributions.contextProviders ?? []) {
        this.contextProviders.register(providerWithinCeiling(provider, manifest));
        registeredProviders.push(provider.id);
      }
      if (active.instance.contributions.turnAnalyzers?.length) {
        const analyzer = active.instance.contributions.turnAnalyzers[0]!;
        this.turnAnalyzer = { pluginId: manifest.id, analyzer: turnAnalyzerWithinCeiling(analyzer) };
        registeredTurnAnalyzer = true;
      }
      if (policyProvider) { this.contextProviders.register(policyProvider); registeredProviders.push(policyProvider.id); }
      for (const skill of active.instance.contributions.skills ?? []) {
        const provider = skillInstructionProvider(manifest, skill);
        if (provider) { if (!isInstructionAuthorityAtMost("scoped", manifest.permissions.instructionAuthority)) throw new TypeError(`skill ${skill.id} instructions exceed the plugin instruction authority ceiling`); this.contextProviders.register(provider); registeredSkillProviders.push(provider.id); }
      }
      for (const hook of active.instance.contributions.hooks ?? []) {
        this.hooks.register(manifest.id, hook);
        registeredHooks.push(hook.id);
      }
      for (const job of active.instance.contributions.jobs ?? []) { this.jobs.register(manifest.id, job); registeredJobs.push(job.id); }
      for (const command of active.instance.contributions.commands ?? []) { this.commands.register(manifest.id, command); registeredCommands.push(command.name); }
      for (const skill of active.instance.contributions.skills ?? []) {
        if (skill.requiredTools?.some(name => !this.tools.get(name))) throw new TypeError(`skill ${skill.id} requires an unavailable tool`);
        if (skill.requiredModels?.some(name => !this.modelProfiles.has(name))) throw new TypeError(`skill ${skill.id} requires an unavailable model profile`);
        this.skills.register(manifest.id, skill); registeredSkills.push(skill.id);
      }
      for (const profile of manifest.contributes.subagentProfiles ?? []) {
        if (profile.requiredTools?.some(name => !this.tools.get(name))) throw new TypeError(`subagent profile ${profile.id} requires an unavailable tool`);
        if (profile.model !== undefined && !this.modelProfiles.has(profile.model)) throw new TypeError(`subagent profile ${profile.id} requires an unknown model profile: ${profile.model}`);
        this.subagentProfiles.register(manifest.id, profile); registeredSubagentProfiles.push(profile.id);
      }
      for (const view of active.instance.contributions.controlPanelViews ?? []) { this.controlPanelViews.register(manifest.id, view); registeredControlPanelViews.push(view.id); }
      active.state = "enabled";
    } catch (error) {
      for (const providerId of registeredProviders.reverse()) this.contextProviders.unregister(providerId);
      if (registeredTurnAnalyzer && this.turnAnalyzer?.pluginId === manifest.id) this.turnAnalyzer = undefined;
      for (const providerId of registeredSkillProviders.reverse()) this.contextProviders.unregister(providerId);
      for (const hookId of registeredHooks.reverse()) this.hooks.unregister(hookId);
      for (const jobId of registeredJobs.reverse()) this.jobs.unregister(jobId);
      for (const commandId of registeredCommands.reverse()) this.commands.unregister(commandId);
      for (const skillId of registeredSkills.reverse()) this.skills.unregister(skillId);
      for (const profileId of registeredSubagentProfiles.reverse()) this.subagentProfiles.unregister(profileId);
      for (const viewId of registeredControlPanelViews.reverse()) this.controlPanelViews.unregister(viewId);
      for (const toolName of registeredTools.reverse()) this.tools.unregister(toolName);
      try {
        await active.instance.stop?.();
      } catch {
        // Preserve the original startup failure. Operational logging belongs to composition.
      }
      try {
        await this.services.searchDocumentProjection?.removeSearchNamespace(manifest.namespace);
      } catch {
        // Preserve the original startup failure. Operational logging belongs to composition.
      }
      active.state = "failed";
      active.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async disable(pluginId: string): Promise<void> {
    const active = this.plugins.get(pluginId);
    if (!active) throw new Error(`plugin is not loaded: ${pluginId}`);
    if (active.state !== "enabled") throw new Error(`plugin ${pluginId} is not enabled`);
    active.state = "stopping";
    for (const view of active.instance.contributions.controlPanelViews ?? []) this.controlPanelViews.unregister(view.id);
    for (const tool of active.instance.contributions.tools ?? []) this.tools.unregister(tool.name);
    for (const provider of active.instance.contributions.contextProviders ?? []) {
      this.contextProviders.unregister(provider.id);
    }
    if (this.turnAnalyzer?.pluginId === pluginId) this.turnAnalyzer = undefined;
    if (active.manifest.contributes.policy?.length) this.contextProviders.unregister(`${active.manifest.id}.policy`);
    for (const skill of active.instance.contributions.skills ?? []) this.contextProviders.unregister(`${active.manifest.id}.skill.${skill.id}`);
    for (const hook of active.instance.contributions.hooks ?? []) this.hooks.unregister(hook.id);
    for (const job of active.instance.contributions.jobs ?? []) this.jobs.unregister(job.id);
    for (const command of active.instance.contributions.commands ?? []) this.commands.unregister(command.name);
    for (const skill of active.instance.contributions.skills ?? []) this.skills.unregister(skill.id);
    for (const profile of active.manifest.contributes.subagentProfiles ?? []) this.subagentProfiles.unregister(profile.id);
    let stopError: unknown;
    try { await active.instance.stop?.(); } catch (error) { stopError = error; }
    try { await this.services.searchDocumentProjection?.removeSearchNamespace(active.manifest.namespace); }
    catch (error) { stopError ??= error; }
    if (stopError) {
      active.state = "failed";
      active.error = stopError instanceof Error ? stopError.message : String(stopError);
      throw stopError;
    }
    active.state = "disabled";
  }

  async remove(pluginId: string): Promise<void> {
    const active = this.plugins.get(pluginId);
    if (!active) throw new Error(`plugin is not loaded: ${pluginId}`);
    if (active.state === "enabled") await this.disable(pluginId);
    else if (active.state === "starting" || active.state === "stopping") throw new Error(`plugin ${pluginId} is ${active.state}`);
    else if (active.state === "failed") await this.services.searchDocumentProjection?.removeSearchNamespace(active.manifest.namespace);
    this.plugins.delete(pluginId);
  }

  get(pluginId: string): LoadedPlugin | undefined {
    const active = this.plugins.get(pluginId);
    return active ? this.snapshot(active) : undefined;
  }

  list(): readonly LoadedPlugin[] {
    return [...this.plugins.values()].map(active => this.snapshot(active)).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Composition root dispatches durable Core events through the Host. */
  async emitHook(event: string, payload: import("../ports/json.js").JsonObject, signal?: AbortSignal): Promise<void> {
    await this.hooks.emit(event, payload, signal);
  }

  listJobs() { return this.jobs.list(); }
  runJob(id: string, signal?: AbortSignal) { return this.jobs.run(id, signal); }
  listCommands() { return this.commands.list(); }
  executeCommand(name: string, input: import("../ports/json.js").JsonObject, context?: { readonly userId: string; readonly channelId?: string; readonly guildId?: string; readonly signal?: AbortSignal }) { return this.commands.execute(name, input, context); }
  autocompleteCommand(name: string, option: string, value: string, context?: { readonly userId: string; readonly channelId?: string; readonly guildId?: string; readonly signal?: AbortSignal }) { return this.commands.complete(name, option, value, context); }
  listSkills() { return this.skills.list(); }
  getSkill(id: string) { return this.skills.get(id); }
  listSubagentProfiles() { return this.subagentProfiles.list(); }
  getSubagentProfile(id: string) { return this.subagentProfiles.get(id); }
  listControlPanelViews() { return this.controlPanelViews.list(); }
  listControlPanelDocuments(viewId: string) { return this.controlPanelViews.listDocuments(viewId); }
  readControlPanelDocument(viewId: string, documentId: string) { return this.controlPanelViews.readDocument(viewId, documentId); }

  /** Run the single enabled turn analyzer against the current event and all registered model-facing tools. */
  async analyzeTurn(input: Omit<TurnAnalyzerInput, "tools">): Promise<TurnAnalysis | undefined> {
    const analyzer = this.turnAnalyzer?.analyzer;
    if (!analyzer) return undefined;
    const tools = this.tools.analysisCandidates();
    try {
      const result = await analyzer.analyze({ ...input, tools });
      if (!result) return undefined;
      const knownTools = new Set(tools.map(tool => tool.name));
      return { ...result, selectedToolNames: result.selectedToolNames.filter(name => knownTools.has(name)) };
    }
    catch (error) {
      if (input.signal?.aborted) throw error;
      return undefined;
    }
  }

  async health(): Promise<readonly PluginHealth[]> {
    const results: PluginHealth[] = [];
    for (const active of this.plugins.values()) {
      if (active.state !== "enabled") { results.push({ id: active.manifest.id, status: active.state === "failed" ? "failed" : "degraded", detail: `plugin is ${active.state}` }); continue; }
      if (!active.instance.health) { results.push({ id: active.manifest.id, status: "ok" }); continue; }
      try {
        const result = await active.instance.health();
        if (!result || (result.status !== "ok" && result.status !== "degraded" && result.status !== "failed")) throw new TypeError("health returned an invalid status");
        results.push({ id: active.manifest.id, ...result });
      } catch (error) {
        results.push({ id: active.manifest.id, status: "failed", detail: error instanceof Error ? error.name : "NonErrorThrown" });
      }
    }
    return results.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }

  private snapshot(active: ActivePlugin): LoadedPlugin {
    return {
      id: active.manifest.id,
      manifest: structuredClone(active.manifest),
      state: active.state,
      ...(active.error ? { error: active.error } : {}),
    };
  }
}
