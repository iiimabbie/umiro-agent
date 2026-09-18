#!/usr/bin/env node
import { access, chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { validatePluginConfig, validatePluginManifest, type PluginManifestV0 } from "@umiro/core";
import { managedPluginPath } from "./plugin-path.js";

const exec = promisify(execFile);
const home = resolve(process.env.UMIRO_HOME?.trim() || join(homedir(), ".umiro"));
const workspace = join(home, "workspace");
const pluginsFile = join(home, "config", "plugins.json");
const configFile = join(home, "config", "umiro.json");
const secretsFile = join(home, "config", "secrets.env");
const app = join(home, "app");
const currentRelease = join(app, "current");
const previousRelease = join(app, "previous");
const sourceTemplates = resolve(new URL("../../../../templates/workspace", import.meta.url).pathname);
const VERSION = "0.1.0";
interface ManagedPlugin { source: string; path: string; workspace?: string; enabled: boolean; config?: Record<string, unknown> }
interface UmiroConfig { model: string; protocol?: "openai_responses" | "openai_chat_completions"; modelCapabilities?: string[]; profiles?: Record<string, { model: string; protocol?: "openai_responses" | "openai_chat_completions"; capabilities?: string[]; reasoningEffort?: string }>; contextMaxTokens?: number; pricing?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>; embedding?: Record<string, unknown>; skills?: string[]; discord?: Record<string, unknown>; webUi?: Record<string, unknown>; plugins?: Array<{ path: string; config?: Record<string, unknown> }> }
const REQUIRED_BUILTIN_PLUGINS = new Set(["context-files", "memory", "host-tools", "discord-tools"]);
type GitHubPluginSource = { owner: string; repository: string; ref?: string; subdirectory?: string };
function parseGitHubPluginSource(value: string): GitHubPluginSource | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+?))?\/?$/.exec(value);
  if (!match) return undefined;
  return { owner: match[1]!, repository: match[2]!, ...(match[3] ? { ref: decodeURIComponent(match[3]) } : {}), ...(match[4] ? { subdirectory: match[4].replace(/\/$/, "") } : {}) };
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function systemTimezone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
async function workspaceTemplates(): Promise<string> {
  const candidates = [
    ...(process.env.UMIRO_SOURCE_DIR?.trim() ? [join(resolve(process.env.UMIRO_SOURCE_DIR.trim()), "templates", "workspace")] : []),
    join(currentRelease, "templates", "workspace"),
    sourceTemplates,
  ];
  for (const candidate of candidates) if (await exists(join(candidate, "BOOTSTRAP.md"))) return candidate;
  throw new Error(`workspace templates not found; checked ${candidates.join(", ")}`);
}
async function loadPlugins(): Promise<ManagedPlugin[]> {
  const raw = JSON.parse(await readFile(pluginsFile, "utf8").catch(() => "[]")) as unknown;
  if (!Array.isArray(raw) || raw.some(item => !item || typeof item !== "object" || Array.isArray(item) || typeof item.source !== "string" || typeof item.path !== "string" || typeof item.enabled !== "boolean")) throw new Error("plugins.json contains an invalid plugin entry");
  return raw as ManagedPlugin[];
}
async function savePlugins(entries: readonly ManagedPlugin[]): Promise<void> {
  await mkdir(dirname(pluginsFile), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(pluginsFile), `.plugins-${crypto.randomUUID()}.json`);
  try { await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, pluginsFile); }
  finally { await rm(temporary, { force: true }); }
}
async function loadConfig(): Promise<UmiroConfig> { return JSON.parse(await readFile(configFile, "utf8")) as UmiroConfig; }
async function saveConfig(config: UmiroConfig): Promise<void> { await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); }
async function saveSecret(name: string, value: string): Promise<void> {
  const source = await readFile(secretsFile, "utf8").catch(() => "");
  const lines = source.split(/\r?\n/);
  const replacement = `${name}=${JSON.stringify(value)}`;
  const index = lines.findIndex(line => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = replacement;
  else lines.push(replacement);
  await mkdir(dirname(secretsFile), { recursive: true, mode: 0o700 });
  await writeFile(secretsFile, `${lines.filter((line, index) => line || index < lines.length - 1).join("\n").trimEnd()}\n`, { mode: 0o600 });
}

async function migrateLegacyEmbeddingSecret(): Promise<void> {
  const config = await loadConfig();
  const embedding = config.embedding;
  const legacyName = typeof embedding?.apiKeyEnv === "string" ? embedding.apiKeyEnv.trim() : "";
  if (!embedding || !legacyName) return;
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(legacyName)) throw new TypeError("embedding.apiKeyEnv contains an invalid legacy secret name");
  const secrets = await readFile(secretsFile, "utf8");
  if (!/^UMIRO_EMBEDDING_API_KEY=/m.test(secrets)) {
    const legacyLine = secrets.split(/\r?\n/).find(line => line.startsWith(`${legacyName}=`));
    const environmentValue = process.env[legacyName];
    const encoded = legacyLine?.slice(legacyName.length + 1) ?? (environmentValue ? JSON.stringify(environmentValue) : undefined);
    if (encoded !== undefined) await writeFile(secretsFile, `${secrets.trimEnd()}\nUMIRO_EMBEDDING_API_KEY=${encoded}\n`, { mode: 0o600 });
  }
  const { apiKeyEnv: _removed, ...currentEmbedding } = embedding;
  await saveConfig({ ...config, embedding: currentEmbedding });
}

function assertPluginEntryInside(root: string, entry: string): void {
  const path = relative(root, entry);
  if (!path || path === ".." || path.startsWith(`..${sep}`)) throw new Error(`plugin entry escapes its directory: ${entry}`);
}

async function validatePluginDirectory(directory: string): Promise<PluginManifestV0 | undefined> {
  const root = await realpath(directory);
  try {
    const manifest = JSON.parse(await readFile(join(root, "umiro.plugin.json"), "utf8")) as unknown;
    validatePluginManifest(manifest);
    const entry = await realpath(join(root, manifest.entry)); assertPluginEntryInside(root, entry); return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { umiro?: { plugin?: string } };
  if (!pkg.umiro?.plugin) throw new Error(`plugin manifest not found: ${root}`);
  const entry = await realpath(join(root, pkg.umiro.plugin)); assertPluginEntryInside(root, entry);
}

function parsedPluginConfig(configJson: string | undefined): Record<string, unknown> {
  if (configJson === undefined) return {};
  const parsed = JSON.parse(configJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("plugin --config must be a JSON object");
  return parsed as Record<string, unknown>;
}

function resolvedPluginConfig(manifest: PluginManifestV0 | undefined, current: Record<string, unknown> | undefined, configJson: string | undefined): Record<string, unknown> {
  const config = { ...(current ?? {}), ...parsedPluginConfig(configJson) };
  if (manifest?.configSchema) {
    const schema = manifest.configSchema;
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Record<string, unknown> : {};
    const workspaceProperty = properties.workspacePath;
    if (required.includes("workspacePath") && config.workspacePath === undefined && workspaceProperty && typeof workspaceProperty === "object" && !Array.isArray(workspaceProperty) && (workspaceProperty as Record<string, unknown>).type === "string") {
      config.workspacePath = workspace;
    }
    validatePluginConfig(manifest, config);
  }
  return config;
}

async function init(): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const templates = await workspaceTemplates();
  for (const name of ["SOUL.md", "AGENT.md", "OWNER.md", "BOOTSTRAP.md"]) if (!await exists(join(workspace, name))) await cp(join(templates, name), join(workspace, name));
  const memoryDirectory = join(workspace, "memory");
  if (await exists(memoryDirectory) || !await exists(join(workspace, "MEMORY.md"))) {
    await mkdir(memoryDirectory, { recursive: true, mode: 0o700 });
    for (const name of ["PREFERENCES.md", "LESSONS.md", "WORKFLOWS.md", "ONGOING.md", "FACTS.md"]) {
      const target = join(memoryDirectory, name);
      if (!await exists(target)) await cp(join(templates, "memory", name), target);
      await chmod(target, 0o600);
    }
  }
  await mkdir(join(home, "config"), { recursive: true, mode: 0o700 });
  if (!await exists(pluginsFile)) await savePlugins([]);
  if (!await exists(configFile)) await writeFile(configFile, `${JSON.stringify({ model: process.env.LLM_MODEL?.trim() || "not-configured", protocol: process.env.LLM_PROTOCOL === "openai_chat_completions" ? "openai_chat_completions" : "openai_responses", contextMaxTokens: 24_000, pricing: {}, embedding: { provider: "disabled" }, skills: [], discord: { ignoredChannels: [], ambientChannels: [], allowedChannels: [], allowedGuilds: [], respondToBots: true, queueMode: "queue", presence: { status: "online", activity: "with ümiro" } }, webUi: { enabled: true, host: "127.0.0.1", port: 3210 }, plugins: [] }, null, 2)}\n`, { mode: 0o600 });
  if (!await exists(secretsFile)) await writeFile(secretsFile, `# DISCORD_TOKEN=\n# LLM_BASE_URL=\n# LLM_API_KEY=\n# UMIRO_OWNER_DISCORD_ID=\n# UMIRO_EMBEDDING_BASE_URL=\n# UMIRO_EMBEDDING_API_KEY=\nUMIRO_WEB_UI_TOKEN=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  await migrateLegacyEmbeddingSecret();
  console.log(home);
}

async function locateSourceRoot(): Promise<string> {
  const explicit = process.env.UMIRO_SOURCE_DIR?.trim(); if (explicit) return resolve(explicit);
  let candidate = dirname(new URL(import.meta.url).pathname);
  for (let depth = 0; depth < 8; depth++) { if (await exists(join(candidate, "pnpm-workspace.yaml")) && await exists(join(candidate, "apps", "gateway"))) return candidate; candidate = dirname(candidate); }
  try { const manifest = JSON.parse(await readFile(join(currentRelease, "install-manifest.json"), "utf8")) as { sourceRoot?: string }; if (manifest.sourceRoot && await exists(manifest.sourceRoot)) return manifest.sourceRoot; } catch { /* no installed source */ }
  throw new Error("source checkout not found; set UMIRO_SOURCE_DIR to an umiro-V2 checkout");
}

async function deployRelease(): Promise<string> {
  const sourceRoot = await locateSourceRoot(); await exec("pnpm", ["build"], { cwd: sourceRoot });
  const revision = await exec("git", ["rev-parse", "--short", "HEAD"], { cwd: sourceRoot }).then(result => result.stdout.trim()).catch(() => "source");
  const releaseId = `${VERSION}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${revision}-${randomBytes(4).toString("hex")}`;
  const release = join(app, "releases", releaseId); await mkdir(release, { recursive: true, mode: 0o700 });
  const targets: Array<[string, string]> = [["@umiro/gateway", "gateway"], ["@umiro/cli", "cli"], ["@umiro/plugin-context-files", "plugins/context-files"], ["@umiro/plugin-memory", "plugins/memory"], ["@umiro/plugin-scheduler", "plugins/scheduler"], ["@umiro/plugin-subagent", "plugins/subagent"], ["@umiro/plugin-host-tools", "plugins/host-tools"], ["@umiro/plugin-discord-tools", "plugins/discord-tools"]];
  try {
    for (const [filter, destination] of targets) await exec("pnpm", ["--filter", filter, "deploy", "--prod", join(release, destination)], { cwd: sourceRoot });
    await cp(join(sourceRoot, "templates"), join(release, "templates"), { recursive: true });
    await writeFile(join(release, "install-manifest.json"), `${JSON.stringify({ releaseId, version: VERSION, revision, sourceRoot, installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) { await rm(release, { recursive: true, force: true }); throw error; }
  const former = await readlink(currentRelease).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
  const temporaryLink = join(app, `.current-${crypto.randomUUID()}`); await symlink(join("releases", releaseId), temporaryLink); await rename(temporaryLink, currentRelease);
  if (former) { const temporaryPrevious = join(app, `.previous-${crypto.randomUUID()}`); await symlink(former, temporaryPrevious); await rename(temporaryPrevious, previousRelease); }
  return release;
}

async function registerBuiltins(): Promise<void> {
  const current = await loadConfig();
  const entries = (await loadPlugins()).filter(entry => !entry.source.startsWith("builtin:"));
  const builtin = (id: string, config: Record<string, unknown> = {}): ManagedPlugin => ({ source: `builtin:${id}`, path: join(currentRelease, "plugins", id), enabled: true, config });
  await savePlugins([...entries, builtin("context-files", { workspacePath: workspace, configFile, skills: current.skills ?? [] }), builtin("memory", { workspacePath: workspace }), builtin("scheduler", { timezone: systemTimezone() }), builtin("subagent"), builtin("host-tools", { workspacePath: workspace }), builtin("discord-tools", { workspacePath: workspace })]);
}

async function writeLaunchers(): Promise<void> {
  await mkdir(join(home, "bin"), { recursive: true, mode: 0o700 });
  const launcher = (entry: string) => `#!/bin/sh\nexport UMIRO_HOME=\"\${UMIRO_HOME:-${home}}\"\nexec \"${process.execPath}\" \"$UMIRO_HOME/app/current/${entry}\" \"$@\"\n`;
  await writeFile(join(home, "bin", "umo"), launcher("cli/dist/src/main.js"), { mode: 0o700 });
  await writeFile(join(home, "bin", "umo-gateway"), launcher("gateway/dist/src/main.js"), { mode: 0o700 });
  await chmod(join(home, "bin", "umo"), 0o700); await chmod(join(home, "bin", "umo-gateway"), 0o700);
}

const unitPath = join(home, "state", "umiro.service");
async function installService(): Promise<boolean> {
  const unit = `[Unit]\nDescription=Umiro Discord Agent\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=UMIRO_HOME=${home}\nEnvironmentFile=-${secretsFile}\nWorkingDirectory=${workspace}\nExecStart=${join(home, "bin", "umo-gateway")}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(join(home, "state"), { recursive: true, mode: 0o700 }); await writeFile(unitPath, unit, { mode: 0o600 });
  if (process.env.UMIRO_NO_SYSTEMD === "1") return false;
  try { await exec("systemctl", ["--user", "link", unitPath]); await exec("systemctl", ["--user", "daemon-reload"]); await exec("systemctl", ["--user", "enable", "umiro.service"]); return true; } catch { return false; }
}

async function install(): Promise<void> {
  for (const name of ["bin", "app", "config", "workspace", "data", "state"]) await mkdir(join(home, name), { recursive: true, mode: 0o700 });
  await init(); const release = await deployRelease(); await registerBuiltins(); await writeLaunchers(); const systemd = await installService();
  console.log(`installed ${release}${systemd ? " (systemd user service enabled)" : " (daemon fallback available)"}`);
}

async function upgrade(): Promise<void> {
  const wasRunning = await systemdActive() || Boolean(await fallbackProcess());
  if (wasRunning) await stop();
  await install();
  if (wasRunning) await start();
}

async function configure(fromEnv?: string): Promise<void> {
  if (!fromEnv) throw new Error("configure requires --from-env <path>");
  const source = resolve(fromEnv); await access(source); await mkdir(dirname(secretsFile), { recursive: true, mode: 0o700 });
  let content = await readFile(source, "utf8"); const imported = parseEnv(content);
  const model = imported.LLM_MODEL?.trim(); const baseUrl = imported.LLM_BASE_URL?.trim();
  if (!model) throw new Error("LLM_MODEL is required in the configuration file");
  if (!baseUrl) throw new Error("LLM_BASE_URL is required in the configuration file");
  const protocol = imported.LLM_PROTOCOL?.trim();
  if (protocol && protocol !== "openai_responses" && protocol !== "openai_chat_completions") throw new Error("LLM_PROTOCOL must be openai_responses or openai_chat_completions");
  const current = await loadConfig();
  const configuredProtocol: UmiroConfig["protocol"] = protocol === "openai_chat_completions" || protocol === "openai_responses" ? protocol : current.protocol ?? "openai_responses";
  await saveConfig({ ...current, model, protocol: configuredProtocol });
  if (!/^UMIRO_WEB_UI_TOKEN=/m.test(content)) content = `${content.trimEnd()}\nUMIRO_WEB_UI_TOKEN=${randomBytes(32).toString("hex")}\n`;
  await writeFile(secretsFile, content, { mode: 0o600 }); await chmod(secretsFile, 0o600); console.log(secretsFile);
}

async function embedding(action: string, provider?: string, model?: string, baseUrl?: string, requestsPerMinute?: string, recallLimit?: string, minSimilarity?: string): Promise<void> {
  const config = await loadConfig();
  if (action === "status") { console.log(JSON.stringify(config.embedding ?? { provider: "disabled" }, null, 2)); return; }
  if (action === "disable") { await saveConfig({ ...config, embedding: { provider: "disabled" } }); console.log("embedding disabled"); return; }
  if (action !== "configure") throw new Error("usage: umo embedding configure|disable|status");
  if (provider !== "gemini" && provider !== "openai-compatible") throw new Error("--provider must be gemini or openai-compatible");
  if (!model?.trim()) throw new Error("embedding configure requires --model");
  if (provider === "openai-compatible" && !baseUrl?.trim()) throw new Error("openai-compatible embedding requires --base-url");
  const rpm = requestsPerMinute === undefined ? undefined : Number(requestsPerMinute);
  const limit = recallLimit === undefined ? undefined : Number(recallLimit);
  const similarity = minSimilarity === undefined ? undefined : Number(minSimilarity);
  if (rpm !== undefined && (!Number.isSafeInteger(rpm) || rpm < 1 || rpm > 600)) throw new Error("--requests-per-minute must be between 1 and 600");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)) throw new Error("--recall-limit must be between 1 and 20");
  if (similarity !== undefined && (!Number.isFinite(similarity) || similarity < 0 || similarity > 1)) throw new Error("--min-similarity must be between 0 and 1");
  const tuning = { ...(rpm !== undefined ? { requestsPerMinute: rpm } : {}), ...(limit !== undefined ? { recallLimit: limit } : {}), ...(similarity !== undefined ? { minSimilarity: similarity } : {}) };
  const next = { provider, model: model.trim(), ...tuning };
  await saveConfig({ ...config, embedding: next });
  if (provider === "openai-compatible") await saveSecret("UMIRO_EMBEDDING_BASE_URL", baseUrl!.trim());
  console.log(`embedding configured: ${provider}/${model.trim()}`);
}

function commaList(value: string | undefined, current: unknown): readonly string[] {
  if (value === undefined) return Array.isArray(current) ? current.filter(item => typeof item === "string") : [];
  return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
}

async function discord(action: string, options: { ignoredChannels: string | undefined; ambientChannels: string | undefined; allowedChannels: string | undefined; allowedGuilds: string | undefined; respondToBots: string | undefined; queueMode: string | undefined; status: string | undefined; activity: string | undefined }): Promise<void> {
  const config = await loadConfig();
  const current = config.discord ?? {};
  if (action === "status") { console.log(JSON.stringify(current, null, 2)); return; }
  if (action !== "configure") throw new Error("usage: umo discord configure|status");
  if (options.respondToBots !== undefined && options.respondToBots !== "true" && options.respondToBots !== "false") throw new Error("--respond-to-bots must be true or false");
  if (options.queueMode !== undefined && options.queueMode !== "queue" && options.queueMode !== "steer") throw new Error("--queue-mode must be queue or steer");
  if (options.status !== undefined && !["online", "idle", "dnd", "invisible"].includes(options.status)) throw new Error("--status must be online, idle, dnd, or invisible");
  if (options.activity !== undefined && !options.activity.trim()) throw new Error("--activity must be non-empty");
  const currentPresence = current.presence && typeof current.presence === "object" && !Array.isArray(current.presence) ? current.presence as Record<string, unknown> : {};
  const next = {
    ignoredChannels: commaList(options.ignoredChannels, current.ignoredChannels),
    ambientChannels: commaList(options.ambientChannels, current.ambientChannels),
    allowedChannels: commaList(options.allowedChannels, current.allowedChannels),
    allowedGuilds: commaList(options.allowedGuilds, current.allowedGuilds),
    respondToBots: options.respondToBots === undefined ? current.respondToBots !== false : options.respondToBots === "true",
    queueMode: options.queueMode ?? current.queueMode ?? "queue",
    presence: { status: options.status ?? currentPresence.status ?? "online", activity: options.activity?.trim() ?? currentPresence.activity ?? "with ümiro" },
  };
  await saveConfig({ ...config, discord: next });
  console.log("discord trigger policy configured");
}

async function web(action: string): Promise<void> {
  if (action === "status") { const config = await loadConfig(); console.log(JSON.stringify(config.webUi ?? { enabled: false }, null, 2)); return; }
  if (action === "token") { const content = await readFile(secretsFile, "utf8"); const token = /^UMIRO_WEB_UI_TOKEN=(.+)$/m.exec(content)?.[1]?.trim(); if (!token) throw new Error("Web UI token is not configured"); console.log(token); return; }
  throw new Error("usage: umo web status|token");
}

const pidFile = join(home, "state", "gateway.pid.json");
const readyFile = join(home, "state", "gateway.ready");
async function fallbackProcess(): Promise<{ pid: number; entry: string } | undefined> { try { const state = JSON.parse(await readFile(pidFile, "utf8")) as { pid: number; entry: string }; process.kill(state.pid, 0); const command = await readFile(`/proc/${state.pid}/cmdline`, "utf8"); if (!command.includes(state.entry)) return undefined; return state; } catch { return undefined; } }
async function systemdActive(): Promise<boolean> { if (process.env.UMIRO_NO_SYSTEMD === "1") return false; try { return (await exec("systemctl", ["--user", "is-active", "umiro.service"])).stdout.trim() === "active"; } catch { return false; } }
type ReadinessState = "ready" | "configuration-required" | "not-ready";
async function readinessState(expectedPid?: number): Promise<ReadinessState> {
  try {
    const current = await loadConfig(); const ui = current.webUi as { enabled?: boolean; host?: string; port?: number } | undefined;
    if (ui?.enabled !== false) {
      const host = ui?.host === "::1" ? "[::1]" : ui?.host ?? "127.0.0.1";
      const response = await fetch(`http://${host}:${ui?.port ?? 3210}/readyz`, { signal: AbortSignal.timeout(1_000) });
      const probe = await response.json() as { pid?: number; status?: string };
      if (response.status === 200 && (expectedPid === undefined || probe.pid === expectedPid)) return probe.status === "configuration_required" ? "configuration-required" : "ready";
    }
  } catch { /* Fall back to durable local evidence when the control panel is disabled or unavailable. */ }
  try {
    const evidence = JSON.parse(await readFile(readyFile, "utf8")) as { pid?: number; checks?: { storage?: boolean; plugins?: boolean; discord?: boolean; scheduler?: boolean; configurationRequired?: string[]; shuttingDown?: boolean } };
    if (!evidence.pid || (expectedPid !== undefined && evidence.pid !== expectedPid)) return "not-ready";
    process.kill(evidence.pid, 0);
    const checks = evidence.checks;
    if (!checks?.storage || !checks.plugins || !checks.scheduler || checks.shuttingDown === true) return "not-ready";
    if (checks.discord) return "ready";
    return checks.configurationRequired?.length ? "configuration-required" : "not-ready";
  } catch { return "not-ready"; }
}
async function printWebUiAccess(): Promise<void> {
  const current = await loadConfig();
  const ui = current.webUi as { enabled?: boolean; host?: string; port?: number } | undefined;
  if (ui?.enabled === false) return;
  const host = ui?.host === "::1" ? "[::1]" : ui?.host ?? "127.0.0.1";
  console.log(`Web UI: http://${host}:${ui?.port ?? 3210}`);
  console.log("Access token: run `umo web token`");
}
async function waitForReady(expectedPid?: number, timeoutMs = 90_000): Promise<Exclude<ReadinessState, "not-ready">> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const state = await readinessState(expectedPid); if (state !== "not-ready") return state; await new Promise(resolveWait => setTimeout(resolveWait, 250)); }
  throw new Error(`gateway did not become ready within ${timeoutMs}ms; inspect ${join(home, "state", "gateway.log")}`);
}
async function status(): Promise<boolean> {
  const manifest: { version?: unknown; revision?: unknown } = await readFile(join(currentRelease, "install-manifest.json"), "utf8").then(raw => JSON.parse(raw) as { version?: unknown; revision?: unknown }).catch(() => ({}));
  const release = `v${typeof manifest.version === "string" ? manifest.version : VERSION}${typeof manifest.revision === "string" ? ` (${manifest.revision})` : ""}`;
  if (await systemdActive()) { console.log(`running (systemd, ${await readinessState()}) ${release}`); return true; }
  const fallback = await fallbackProcess(); if (fallback) { console.log(`running ${fallback.pid} (${await readinessState(fallback.pid)}) ${release}`); return true; }
  console.log("stopped"); return false;
}
async function start(): Promise<void> {
  if (await status()) { await printWebUiAccess(); return; } if (!await exists(join(currentRelease, "gateway", "dist", "src", "main.js"))) await install();
  await mkdir(join(home, "state"), { recursive: true, mode: 0o700 });
  await rm(readyFile, { force: true });
  if (process.env.UMIRO_NO_SYSTEMD !== "1") {
    let startedBySystemd = false;
    try { await exec("systemctl", ["--user", "start", "umiro.service"]); startedBySystemd = await systemdActive(); } catch { /* fallback */ }
    if (startedBySystemd) { const state = await waitForReady(); console.log(`started (systemd, ${state})`); await printWebUiAccess(); return; }
  }
  const entry = resolve(process.env.UMIRO_GATEWAY_ENTRY?.trim() || join(currentRelease, "gateway", "dist", "src", "main.js")); const logPath = join(home, "state", "gateway.log"); const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, UMIRO_HOME: home } }); child.unref(); if (!child.pid) throw new Error("gateway failed to start");
  await writeFile(pidFile, `${JSON.stringify({ pid: child.pid, entry, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 }); await new Promise(resolveWait => setTimeout(resolveWait, 500));
  try { process.kill(child.pid, 0); } catch { throw new Error(`gateway exited during startup; inspect ${logPath}`); }
  const state = await waitForReady(child.pid); console.log(`started ${child.pid} (${state})`); await printWebUiAccess();
}
async function stop(): Promise<void> {
  if (await systemdActive()) { await exec("systemctl", ["--user", "stop", "umiro.service"]); await rm(readyFile, { force: true }); console.log("stopped (systemd)"); return; }
  const processState = await fallbackProcess();
  if (processState) {
    process.kill(processState.pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { try { process.kill(processState.pid, 0); } catch { break; } await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
    try { process.kill(processState.pid, 0); throw new Error(`gateway ${processState.pid} did not stop within 10000ms`); } catch (error) { if (error instanceof Error && error.message.includes("did not stop")) throw error; }
  }
  await rm(pidFile, { force: true }); await rm(readyFile, { force: true }); console.log("stopped");
}

async function restart(): Promise<void> { await stop(); await start(); }

async function uninstall(purge = false): Promise<void> {
  const target = resolve(home);
  if (purge) {
    const forbidden = new Set([resolve("/"), resolve(homedir()), resolve(process.cwd())]);
    if (forbidden.has(target)) throw new Error(`refusing to purge unsafe UMIRO_HOME: ${target}`);
    if (!await exists(configFile) || !await exists(pluginsFile) || !await exists(workspace)) throw new Error(`refusing to purge a directory without Umiro installation markers: ${target}`);
  }
  await stop();
  if (process.env.UMIRO_NO_SYSTEMD !== "1") {
    await exec("systemctl", ["--user", "disable", "--now", "umiro.service"]).catch(() => undefined);
    await exec("systemctl", ["--user", "unlink", unitPath]).catch(() => undefined);
    await exec("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
  await rm(unitPath, { force: true });
  if (purge) {
    await rm(target, { recursive: true, force: true }); console.log(`uninstalled and purged ${target}`); return;
  }
  await rm(app, { recursive: true, force: true }); await rm(join(home, "bin"), { recursive: true, force: true });
  await rm(pidFile, { force: true }); await rm(readyFile, { force: true }); await rm(join(home, "state", "gateway.lock"), { force: true });
  console.log(`uninstalled; preserved config, workspace, data, and logs in ${home}`);
}
async function rollback(): Promise<void> {
  const wasRunning = await systemdActive() || Boolean(await fallbackProcess());
  if (wasRunning) await stop();
  const current = await readlink(currentRelease); const previous = await readlink(previousRelease).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
  if (!previous || !await exists(join(app, previous))) throw new Error("no previous release available");
  const temporaryCurrent = join(app, `.current-${crypto.randomUUID()}`); await symlink(previous, temporaryCurrent); await rename(temporaryCurrent, currentRelease);
  const temporaryPrevious = join(app, `.previous-${crypto.randomUUID()}`); await symlink(current, temporaryPrevious); await rename(temporaryPrevious, previousRelease);
  await registerBuiltins(); await writeLaunchers();
  if (wasRunning) await start();
  console.log(`rolled back to ${previous.split("/").pop()}`);
}

async function backup(destination?: string): Promise<void> {
  if (!destination) throw new Error("backup requires a destination directory");
  if (await systemdActive() || await fallbackProcess()) throw new Error("stop the daemon before creating a backup");
  const target = resolve(destination); if (await exists(target)) throw new Error(`backup destination already exists: ${target}`);
  const parent = dirname(target); await mkdir(parent, { recursive: true, mode: 0o700 }); const temporaryTarget = join(parent, `.${target.split(sep).pop()}-${crypto.randomUUID()}.tmp`); await mkdir(temporaryTarget, { mode: 0o700 });
  await access(join(home, "data", "umiro.sqlite"));
  try {
    await cp(join(home, "data", "umiro.sqlite"), join(temporaryTarget, "umiro.sqlite"));
    if (await exists(join(home, "data", "artifacts"))) await cp(join(home, "data", "artifacts"), join(temporaryTarget, "artifacts"), { recursive: true });
    const files = await backupFiles(temporaryTarget);
    await writeFile(join(temporaryTarget, "backup.json"), `${JSON.stringify({ format: 2, createdAt: new Date().toISOString(), files }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryTarget, target);
  } finally { await rm(temporaryTarget, { recursive: true, force: true }); }
  console.log(target);
}

async function restore(source?: string): Promise<void> {
  if (!source) throw new Error("restore requires a backup directory");
  if (await systemdActive() || await fallbackProcess()) throw new Error("stop the daemon before restoring a backup");
  const sourceRoot = await realpath(resolve(source)); const manifest = JSON.parse(await readFile(join(sourceRoot, "backup.json"), "utf8")) as { format?: unknown; files?: unknown };
  if (manifest.format !== 2 || !Array.isArray(manifest.files)) throw new Error("unsupported or malformed backup manifest");
  const expected = manifest.files as Array<{ path?: unknown; size?: unknown; sha256?: unknown }>;
  if (expected.some(item => typeof item.path !== "string" || typeof item.size !== "number" || typeof item.sha256 !== "string")) throw new Error("malformed backup file record");
  const actual = await backupFiles(sourceRoot); const normalized = expected.map(item => ({ path: item.path as string, size: item.size as number, sha256: item.sha256 as string })).sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(normalized) || !actual.some(item => item.path === "umiro.sqlite")) throw new Error("backup integrity verification failed");
  const dataRoot = join(home, "data"); await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const temporary = join(dataRoot, `.umiro-restore-${crypto.randomUUID()}.sqlite`);
  await cp(join(sourceRoot, "umiro.sqlite"), temporary); await chmod(temporary, 0o600);
  await rename(temporary, join(dataRoot, "umiro.sqlite"));
  if (await exists(join(sourceRoot, "artifacts"))) {
    const artifactTarget = join(dataRoot, "artifacts");
    await rm(artifactTarget, { recursive: true, force: true });
    await cp(join(sourceRoot, "artifacts"), artifactTarget, { recursive: true });
  }
  console.log(sourceRoot);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveDone, reject) => { const stream = createReadStream(path); stream.on("data", chunk => hash.update(chunk)); stream.once("error", reject); stream.once("end", resolveDone); });
  return hash.digest("hex");
}

async function backupFiles(root: string, directory = root): Promise<Array<{ path: string; size: number; sha256: string }>> {
  const output: Array<{ path: string; size: number; sha256: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === "backup.json") continue;
    const path = join(directory, entry.name); const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`backup contains a symbolic link: ${relative(root, path)}`);
    if (metadata.isDirectory()) output.push(...await backupFiles(root, path));
    else if (metadata.isFile()) output.push({ path: relative(root, path).split(sep).join("/"), size: metadata.size, sha256: await sha256(path) });
    else throw new Error(`backup contains an unsupported file type: ${relative(root, path)}`);
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

async function plugin(action: string, source?: string, workspaceName?: string, configJson?: string): Promise<void> {
  const entries = await loadPlugins(); if (action === "list") { console.log(entries.map(item => `${item.source.startsWith("builtin:") ? "built-in" : "external"}\t${item.enabled ? "enabled" : "disabled"}\t${item.source}${item.workspace ? `#${item.workspace}` : ""}`).join("\n")); return; } if (!source) throw new Error(`plugin ${action} requires a path`);
  const restartRuntime = process.env.UMIRO_PLUGIN_ACTION_FROM_GATEWAY !== "1" && (await systemdActive() || Boolean(await fallbackProcess()));
  if (action === "remove" && source.startsWith("builtin:")) throw new Error("built-in capabilities cannot be removed; disable them instead");
  let path = resolve(source); const installing = action === "install" || action === "update";
  const github = parseGitHubPluginSource(source); const githubSource = github !== undefined;
  const selectedWorkspace = workspaceName ?? (github?.subdirectory?.split("/").filter(Boolean).pop());
  if (github) path = managedPluginPath(join(app, "plugins"), github.repository, selectedWorkspace);
  const matches = (item: ManagedPlugin) => item.path === path || (item.source === source && item.workspace === selectedWorkspace);
  const previousEntry = entries.find(matches);
  if (!installing && !previousEntry) throw new Error(`plugin is not installed: ${source}${selectedWorkspace ? `#${selectedWorkspace}` : ""}`);
  const installedBuiltinId = previousEntry?.source.startsWith("builtin:") ? previousEntry.source.slice("builtin:".length) : undefined;
  if (action === "remove" && installedBuiltinId) throw new Error("built-in capabilities cannot be removed");
  if (action === "disable" && installedBuiltinId && REQUIRED_BUILTIN_PLUGINS.has(installedBuiltinId)) throw new Error(`required built-in capability cannot be disabled: ${installedBuiltinId}`);
  if (!installing && previousEntry) path = previousEntry.path;
  let manifest: PluginManifestV0 | undefined;
  let nextConfig: Record<string, unknown> | undefined;
  if (githubSource) {
    if (installing) {
      const pluginRoot = join(app, "plugins"); const nonce = crypto.randomUUID(); const checkout = join(pluginRoot, `.checkout-${nonce}`); const candidate = join(pluginRoot, `.candidate-${nonce}`); const previous = join(pluginRoot, `.previous-${nonce}`);
      await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
      try {
        const cloneArgs = ["clone", "--depth", "1", ...(github?.ref ? ["--branch", github.ref] : []), `https://github.com/${github!.owner}/${github!.repository}.git`, checkout];
        await exec("git", cloneArgs);
        if (github?.subdirectory || selectedWorkspace) { const selected = github?.subdirectory ? join(checkout, github.subdirectory) : (await exists(join(checkout, selectedWorkspace!)) ? join(checkout, selectedWorkspace!) : join(checkout, "packages", selectedWorkspace!)); await access(join(selected, "package.json")); await cp(selected, candidate, { recursive: true }); }
        else await rename(checkout, candidate);
        const manager = await exists(join(candidate, "pnpm-lock.yaml")) ? "pnpm" : "npm"; await exec(manager, manager === "pnpm" ? ["install", "--frozen-lockfile"] : ["install", "--ignore-scripts"], { cwd: candidate }); await exec(manager, ["run", "build"], { cwd: candidate });
        manifest = await validatePluginDirectory(candidate);
        nextConfig = resolvedPluginConfig(manifest, previousEntry?.config, configJson);
        const replacing = await exists(path); if (replacing) await rename(path, previous);
        try { await rename(candidate, path); } catch (error) { if (replacing) await rename(previous, path); throw error; }
        await rm(previous, { recursive: true, force: true });
      } finally { await rm(checkout, { recursive: true, force: true }); await rm(candidate, { recursive: true, force: true }); }
    }
  } else if (installing && /^(?:https?|git):/.test(source)) throw new Error("only public GitHub HTTPS plugin URLs are supported");
  if (installing && !githubSource) {
    manifest = await validatePluginDirectory(path);
    nextConfig = resolvedPluginConfig(manifest, previousEntry?.config, configJson);
  }
  if (action === "configure" || action === "enable") {
    manifest = await validatePluginDirectory(path);
    nextConfig = resolvedPluginConfig(manifest, previousEntry?.config, configJson);
  }
  let next = entries;
  if (installing) { next = [...entries.filter(item => !matches(item)), { source, path, ...(selectedWorkspace ? { workspace: selectedWorkspace } : {}), enabled: previousEntry?.enabled ?? true, ...(nextConfig && Object.keys(nextConfig).length ? { config: nextConfig } : {}) }]; }
  else if (action === "remove") next = entries.filter(item => !matches(item));
  else if (action === "enable" || action === "disable") next = entries.map(item => matches(item) ? { ...item, enabled: action === "enable", ...(action === "enable" && nextConfig && Object.keys(nextConfig).length ? { config: nextConfig } : {}) } : item);
  else if (action === "configure") next = entries.map(item => matches(item) ? { ...item, ...(nextConfig && Object.keys(nextConfig).length ? { config: nextConfig } : {}) } : item);
  else throw new Error(`unsupported plugin action: ${action}`);
  await savePlugins(next); if (action === "remove" && path.startsWith(`${join(app, "plugins")}/`) && !source.startsWith("builtin:")) await rm(path, { recursive: true, force: true }); console.log(`${action}: ${path}`);
  if (restartRuntime) await restart();
}

const args = process.argv.slice(2).filter((value, index) => value !== "--" || index > 0); const [command, action, source] = args; const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
if (command === "--version" || command === "version") console.log(VERSION); else if (command === "install") await install(); else if (command === "upgrade") await upgrade(); else if (command === "uninstall") await uninstall(args.includes("--purge")); else if (command === "init") await init(); else if (command === "configure") await configure(option("--from-env")); else if (command === "embedding") await embedding(action ?? "status", option("--provider"), option("--model"), option("--base-url"), option("--requests-per-minute"), option("--recall-limit"), option("--min-similarity")); else if (command === "discord") await discord(action ?? "status", { ignoredChannels: option("--ignored-channels"), ambientChannels: option("--ambient-channels"), allowedChannels: option("--allowed-channels"), allowedGuilds: option("--allowed-guilds"), respondToBots: option("--respond-to-bots"), queueMode: option("--queue-mode"), status: option("--status"), activity: option("--activity") }); else if (command === "web") await web(action ?? "status"); else if (command === "start") await start(); else if (command === "stop") await stop(); else if (command === "restart") await restart(); else if (command === "status") await status(); else if (command === "rollback") await rollback(); else if (command === "backup") await backup(action); else if (command === "restore") await restore(action); else if (command === "plugin") await plugin(action ?? "list", source, option("--workspace"), option("--config")); else throw new Error("usage: umo --version|install|upgrade|rollback|backup DIR|restore DIR|uninstall [--purge]|init|configure --from-env .env|embedding configure|disable|status|discord configure|status|web status|token|start|stop|restart|status|plugin ...");
