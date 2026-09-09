import { isInstructionAuthorityAtMost, type Authority } from "../authorization/authority.js";
import { Ajv } from "ajv";
import { ContextProviderRegistry } from "../context/registry.js";
import type { ContextProvider } from "../context/contract.js";
import { ToolRegistry } from "../tool/registry.js";
import type { LoadedPlugin, PluginEnableOptions, PluginHostServices, PluginInstance, PluginManifestV0, PluginModule, PluginLogger } from "./contract.js";
import { NOOP_LOGGER, type StructuredLogger } from "../observability/logger.js";
import { validatePluginManifest } from "./manifest.js";
import type { PluginStateStore } from "./state.js";
import { PluginHookRegistry } from "./hooks.js";
import { PluginCommandRegistry, PluginJobRegistry, SkillRegistry } from "./contributions.js";

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

export class PluginHost {
  private readonly plugins = new Map<string, ActivePlugin>();
  private readonly ajv = new Ajv({ allErrors: true, strict: true });

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
    private readonly logger: StructuredLogger = NOOP_LOGGER,
  ) {}

  async enable(module: PluginModule, options: PluginEnableOptions = {}): Promise<void> {
    const { manifest } = module;
    validatePluginManifest(manifest, this.hostAuthorityCeiling);
    if (this.plugins.has(manifest.id)) throw new Error(`plugin already loaded: ${manifest.id}`);

    const config = structuredClone(options.config ?? {});
    if (manifest.configSchema) {
      const validateConfig = this.ajv.compile(manifest.configSchema);
      if (!validateConfig(config)) {
        const detail = validateConfig.errors?.map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
        throw new TypeError(`plugin ${manifest.id} config is invalid: ${detail ?? "unknown schema violation"}`);
      }
    }
    const allowedSecrets = new Set(manifest.requiredSecrets ?? []);
    for (const secret of allowedSecrets) {
      if (!options.secrets?.[secret]) throw new TypeError(`plugin ${manifest.id} requires secret ${secret}`);
    }

    const active: ActivePlugin = {
      manifest,
      instance: await module.create({
        pluginId: manifest.id,
        namespace: manifest.namespace,
        permissionCeiling: manifest.permissions,
        config,
        ...(this.stateForNamespace ? { state: this.stateForNamespace(manifest.namespace) } : {}),
        services: this.services,
        logger: pluginLogger(this.logger, manifest.id, manifest.namespace, Object.values(options.secrets ?? {})),
        getSecret: name => allowedSecrets.has(name) ? options.secrets?.[name] : undefined,
      }),
      state: "starting",
    };
    this.plugins.set(manifest.id, active);

    const toolNames = active.instance.contributions.tools?.map(tool => tool.name) ?? [];
    const providerIds = active.instance.contributions.contextProviders?.map(provider => provider.id) ?? [];
    const hookIds = active.instance.contributions.hooks?.map(hook => hook.id) ?? [];
    const jobIds = active.instance.contributions.jobs?.map(job => job.id) ?? [];
    const commandIds = active.instance.contributions.commands?.map(command => command.name) ?? [];
    const skillIds = active.instance.contributions.skills?.map(skill => skill.id) ?? [];
    const registeredTools: string[] = [];
    const registeredProviders: string[] = [];
    const registeredHooks: string[] = [];
    const registeredJobs: string[] = [];
    const registeredCommands: string[] = [];
    const registeredSkills: string[] = [];
    const registeredSkillProviders: string[] = [];
    const policyProvider = manifestPolicyProvider(manifest);
    try {
      exactContributionSet(toolNames, manifest.contributes.tools, `plugin ${manifest.id} tools`);
      exactContributionSet(providerIds, manifest.contributes.contextProviders, `plugin ${manifest.id} context providers`);
      exactContributionSet(hookIds, manifest.contributes.hooks, `plugin ${manifest.id} hooks`);
      exactContributionSet(jobIds, manifest.contributes.jobs, `plugin ${manifest.id} jobs`);
      exactContributionSet(commandIds, manifest.contributes.commands, `plugin ${manifest.id} commands`);
      exactContributionSet(skillIds, manifest.contributes.skills, `plugin ${manifest.id} skills`);
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
        this.skills.register(manifest.id, skill); registeredSkills.push(skill.id);
      }
      active.state = "enabled";
    } catch (error) {
      for (const providerId of registeredProviders.reverse()) this.contextProviders.unregister(providerId);
      for (const providerId of registeredSkillProviders.reverse()) this.contextProviders.unregister(providerId);
      for (const hookId of registeredHooks.reverse()) this.hooks.unregister(hookId);
      for (const jobId of registeredJobs.reverse()) this.jobs.unregister(jobId);
      for (const commandId of registeredCommands.reverse()) this.commands.unregister(commandId);
      for (const skillId of registeredSkills.reverse()) this.skills.unregister(skillId);
      for (const toolName of registeredTools.reverse()) this.tools.unregister(toolName);
      try {
        await active.instance.stop?.();
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
    for (const tool of active.instance.contributions.tools ?? []) this.tools.unregister(tool.name);
    for (const provider of active.instance.contributions.contextProviders ?? []) {
      this.contextProviders.unregister(provider.id);
    }
    if (active.manifest.contributes.policy?.length) this.contextProviders.unregister(`${active.manifest.id}.policy`);
    for (const skill of active.instance.contributions.skills ?? []) this.contextProviders.unregister(`${active.manifest.id}.skill.${skill.id}`);
    for (const hook of active.instance.contributions.hooks ?? []) this.hooks.unregister(hook.id);
    for (const job of active.instance.contributions.jobs ?? []) this.jobs.unregister(job.id);
    for (const command of active.instance.contributions.commands ?? []) this.commands.unregister(command.name);
    for (const skill of active.instance.contributions.skills ?? []) this.skills.unregister(skill.id);
    try {
      await active.instance.stop?.();
      active.state = "disabled";
    } catch (error) {
      active.state = "failed";
      active.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
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
  listSkills() { return this.skills.list(); }
  getSkill(id: string) { return this.skills.get(id); }

  private snapshot(active: ActivePlugin): LoadedPlugin {
    return {
      id: active.manifest.id,
      manifest: structuredClone(active.manifest),
      state: active.state,
      ...(active.error ? { error: active.error } : {}),
    };
  }
}
