import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePluginManifest, type JsonObject, type PluginCommandDefinition, type PluginHookDefinition, type PluginInstance, type PluginJobDefinition, type PluginManifestV0, type PluginModule, type PluginSetupContext, type ToolDefinition, type ToolExecutionResult } from "@umiro/core";

interface V2Entry { readonly createPlugin?: (context: PluginSetupContext) => PluginInstance | Promise<PluginInstance> }
interface LegacyTool { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown>; readonly execute: (input: Record<string, unknown>) => Promise<string> | string }
interface LegacyModule {
  readonly manifest: { readonly name: string; readonly start?: (context: LegacyRuntime) => Promise<void> | void; readonly stop?: (context: LegacyRuntime) => Promise<void> | void };
  readonly tools?: readonly { readonly tool: LegacyTool; readonly ownerOnly?: boolean }[];
  readonly schedules?: readonly { readonly id: string; readonly schedule: string; readonly timezone?: string; readonly run: (context: LegacyRuntime) => Promise<void> | void }[];
  readonly commands?: readonly { readonly name: string; readonly description: string; readonly ownerOnly?: boolean; readonly ephemeral?: boolean; readonly options?: PluginCommandDefinition["options"]; readonly execute: (input: Record<string, unknown>, context: { userId: string; channelId: string; guildId?: string; config: LegacyConfig }) => Promise<string> | string }[];
  readonly events?: readonly { readonly event: string; readonly id: string; readonly run: (payload: Record<string, unknown>, context: LegacyRuntime) => Promise<void> | void }[];
}
interface LegacyConfig { readonly path: string; read<T extends Record<string, unknown>>(defaults: T): T; write(value: Record<string, unknown>): void; update<T extends Record<string, unknown>>(defaults: T, updater: (current: T) => Record<string, unknown>): T }
interface LegacyRuntime { readonly config: LegacyConfig; readonly messages: { sendText(input: { channelId: string; content: string }): Promise<{ messageId: string }>; editText(input: { channelId: string; messageId: string; content: string }): Promise<{ messageId: string; migrated: boolean }> }; ask(prompt: string, options?: { systemPrompt?: string; maxTurns?: number; model?: string }): Promise<{ text: string }> }

function assertInside(root: string, candidate: string): void { const path = relative(root, candidate); if (path === "" || path === ".." || path.startsWith(`..${sep}`) || resolve(root, path) !== candidate) throw new Error(`plugin entry escapes its directory: ${candidate}`); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function merge<T extends Record<string, unknown>>(defaults: T, value: unknown): T { const output = structuredClone(defaults) as Record<string, unknown>; if (record(value)) for (const [key, item] of Object.entries(value)) output[key] = record(output[key]) && record(item) ? merge(output[key] as Record<string, unknown>, item) : structuredClone(item); return output as T; }
function legacyConfig(directory: string, name: string): LegacyConfig {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new TypeError(`invalid legacy plugin name: ${name}`);
  const path = join(directory, `${name}.json`); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const load = () => { try { const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; return record(parsed) ? parsed : {}; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } };
  const save = (value: Record<string, unknown>) => { const temporary = `${path}.${crypto.randomUUID()}.tmp`; try { writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, path); } finally { try { unlinkSync(temporary); } catch { /* renamed */ } } };
  return { path, read: defaults => merge(defaults, load()), write: save, update(defaults, updater) { const next = updater(merge(defaults, load())); if (!record(next)) throw new TypeError("legacy plugin config updater must return an object"); save(next); return merge(defaults, next); } };
}
const succeeded = (output: unknown): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus: "confirmed" });

async function loadV2(root: string): Promise<PluginModule | undefined> {
  const manifestPath = join(root, "umiro.plugin.json"); let manifest: PluginManifestV0;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PluginManifestV0; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(`failed to read plugin manifest: ${manifestPath}`, { cause: error }); }
  validatePluginManifest(manifest); const entry = await realpath(join(root, manifest.entry)); assertInside(root, entry); const imported = await import(pathToFileURL(entry).href) as V2Entry;
  if (typeof imported.createPlugin !== "function") throw new TypeError(`plugin entry ${entry} must export createPlugin()`); return { manifest, create: imported.createPlugin };
}

async function loadLegacy(root: string): Promise<PluginModule> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string; umiro?: { name?: string; plugin?: string } };
  if (!pkg.umiro?.plugin) throw new Error(`plugin manifest not found: ${root}`); const entry = await realpath(join(root, pkg.umiro.plugin)); assertInside(root, entry);
  const imported = await import(pathToFileURL(entry).href) as { default?: LegacyModule }; const legacy = imported.default;
  if (!legacy?.manifest?.name) throw new TypeError(`legacy plugin entry ${entry} has no default manifest`); const id = (pkg.umiro.name ?? legacy.manifest.name).toLowerCase();
  const toolNames = legacy.tools?.map(item => item.tool.name) ?? []; const capabilities = toolNames.map(name => `legacy.${id}.${name}`);
  const manifest: PluginManifestV0 = { schemaVersion: 0, id, version: pkg.version ?? "0.0.0", coreApi: "0", entry: `./${relative(root, entry).split(sep).join("/")}`, namespace: id, permissions: { capabilities, visibility: { kind: "all" }, instructionAuthority: "none" }, contributes: { tools: toolNames, jobs: legacy.schedules?.map(job => `${id}.${job.id}`) ?? [], commands: legacy.commands?.map(command => command.name) ?? [], hooks: legacy.events?.map(event => `${id}.${event.id}`) ?? [] } };
  validatePluginManifest(manifest);
  return { manifest, async create(setup) {
    const services = setup.services?.legacy; if (!services) throw new Error(`legacy plugin ${id} requires gateway compatibility services`); const config = legacyConfig(services.configDirectory, id);
    const runtime: LegacyRuntime = { config, ask: services.ask, messages: { sendText: services.sendText, editText: services.editText } };
    const tools: ToolDefinition[] = (legacy.tools ?? []).map(registration => ({ name: registration.tool.name, description: registration.tool.description, inputSchema: registration.tool.parameters, policy: { capability: `legacy.${id}.${registration.tool.name}`, tier: registration.ownerOnly === false ? "common" : "privileged", interactionRequirement: "not_required", sideEffect: "non_idempotent" }, async execute(input) { try { return succeeded(await registration.tool.execute(input)); } catch (error) { return { ok: false, effectStatus: "unknown", error: { code: "legacy_plugin_error", message: error instanceof Error ? error.message : String(error), retryable: false } }; } } }));
    const jobs: PluginJobDefinition[] = (legacy.schedules ?? []).map(job => ({ id: `${id}.${job.id}`, schedule: job.schedule, ...(job.timezone ? { timezone: job.timezone } : {}), maxAttempts: 3, misfirePolicy: "coalesce", async run() { await job.run(runtime); } }));
    const commands: PluginCommandDefinition[] = (legacy.commands ?? []).map(command => ({ name: command.name, description: command.description, ownerOnly: command.ownerOnly ?? true, ephemeral: command.ephemeral ?? true, ...(command.options ? { options: command.options } : {}), async execute(input, commandContext) { const result = await command.execute(input, { userId: commandContext?.userId ?? "unknown", channelId: commandContext?.channelId ?? "unknown", ...(commandContext?.guildId ? { guildId: commandContext.guildId } : {}), config }); return { text: result }; } }));
    const hooks: PluginHookDefinition[] = (legacy.events ?? []).map(event => ({ id: `${id}.${event.id}`, event: event.event, async handle(payload) { await event.run({ event: event.event, ...payload }, runtime); } }));
    return { contributions: { tools, jobs, commands, hooks }, start: async () => { await legacy.manifest.start?.(runtime); }, stop: async () => { await legacy.manifest.stop?.(runtime); } };
  } };
}

export async function loadPluginModule(pluginDirectory: string): Promise<PluginModule> { const root = await realpath(pluginDirectory); return await loadV2(root) ?? loadLegacy(root); }
export function pluginDirectoryFromManifestPath(manifestPath: string): string { return dirname(resolve(manifestPath)); }
