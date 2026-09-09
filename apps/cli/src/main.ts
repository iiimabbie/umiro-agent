#!/usr/bin/env node
import { access, chmod, cp, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { validatePluginManifest } from "@umiro/core";
import { managedPluginPath } from "./plugin-path.js";

const exec = promisify(execFile);
const home = resolve(process.env.UMIRO_HOME?.trim() || join(homedir(), ".umiro-v2"));
const workspace = join(home, "workspace");
const pluginsFile = join(home, "config", "plugins.json");
const configFile = join(home, "config", "umiro.json");
const secretsFile = join(home, "config", "secrets.env");
const app = join(home, "app");
const currentRelease = join(app, "current");
const templates = resolve(new URL("../../../../templates/workspace", import.meta.url).pathname);
interface ManagedPlugin { source: string; path: string; workspace?: string; enabled: boolean; config?: Record<string, unknown> }
interface UmiroConfig { model: string; embedding?: Record<string, unknown>; discord?: Record<string, unknown>; webUi?: Record<string, unknown>; plugins?: Array<{ path: string; config?: Record<string, unknown> }> }

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function loadPlugins(): Promise<ManagedPlugin[]> {
  const raw = JSON.parse(await readFile(pluginsFile, "utf8").catch(() => "[]")) as Array<string | ManagedPlugin>;
  return raw.map(item => typeof item === "string" ? { source: item, path: item, enabled: true } : item);
}
async function savePlugins(entries: readonly ManagedPlugin[]): Promise<void> {
  await mkdir(dirname(pluginsFile), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(pluginsFile), `.plugins-${crypto.randomUUID()}.json`);
  try { await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, pluginsFile); }
  finally { await rm(temporary, { force: true }); }
}
async function loadConfig(): Promise<UmiroConfig> { return JSON.parse(await readFile(configFile, "utf8")) as UmiroConfig; }
async function saveConfig(config: UmiroConfig): Promise<void> { await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); }

function assertPluginEntryInside(root: string, entry: string): void {
  const path = relative(root, entry);
  if (!path || path === ".." || path.startsWith(`..${sep}`)) throw new Error(`plugin entry escapes its directory: ${entry}`);
}

async function validatePluginDirectory(directory: string): Promise<void> {
  const root = await realpath(directory);
  try {
    const manifest = JSON.parse(await readFile(join(root, "umiro.plugin.json"), "utf8")) as unknown;
    validatePluginManifest(manifest);
    const entry = await realpath(join(root, manifest.entry)); assertPluginEntryInside(root, entry); return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { umiro?: { plugin?: string } };
  if (!pkg.umiro?.plugin) throw new Error(`plugin manifest not found: ${root}`);
  const entry = await realpath(join(root, pkg.umiro.plugin)); assertPluginEntryInside(root, entry);
}

async function init(): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const name of ["SOUL.md", "AGENT.md", "OWNER.md", "MEMORY.md", "PEOPLE.md"]) if (!await exists(join(workspace, name))) await cp(join(templates, name), join(workspace, name));
  await mkdir(join(home, "config"), { recursive: true, mode: 0o700 });
  if (!await exists(pluginsFile)) await savePlugins([]);
  if (!await exists(configFile)) await writeFile(configFile, `${JSON.stringify({ model: process.env.LLM_MODEL?.trim() || "gemma4:31b", embedding: { provider: "disabled" }, discord: { ignoredChannels: [], ambientChannels: [], allowedChannels: [], allowedGuilds: [], respondToBots: false }, webUi: { enabled: true, host: "127.0.0.1", port: 3210 }, plugins: [] }, null, 2)}\n`, { mode: 0o600 });
  if (!await exists(secretsFile)) await writeFile(secretsFile, `# DISCORD_TOKEN=\n# LLM_BASE_URL=\n# LLM_API_KEY=\n# UMIRO_OWNER_DISCORD_ID=\n# GOOGLE_API_KEY=\n# UMIRO_EMBEDDING_API_KEY=\nUMIRO_WEB_UI_TOKEN=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
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
  const releaseId = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${revision}`;
  const release = join(app, "releases", releaseId); await mkdir(release, { recursive: true, mode: 0o700 });
  const targets: Array<[string, string]> = [["@umiro/gateway", "gateway"], ["@umiro/cli", "cli"], ["@umiro/plugin-context-files", "plugins/context-files"], ["@umiro/plugin-people", "plugins/people"], ["@umiro/plugin-memory", "plugins/memory"], ["@umiro/plugin-scheduler", "plugins/scheduler"], ["@umiro/plugin-subagent", "plugins/subagent"]];
  try {
    for (const [filter, destination] of targets) await exec("pnpm", ["--filter", filter, "deploy", "--prod", join(release, destination)], { cwd: sourceRoot });
    await cp(join(sourceRoot, "templates"), join(release, "templates"), { recursive: true });
    await writeFile(join(release, "install-manifest.json"), `${JSON.stringify({ releaseId, revision, sourceRoot, installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) { await rm(release, { recursive: true, force: true }); throw error; }
  const temporaryLink = join(app, `.current-${crypto.randomUUID()}`); await symlink(join("releases", releaseId), temporaryLink); await rename(temporaryLink, currentRelease);
  return release;
}

async function registerBuiltins(): Promise<void> {
  const entries = (await loadPlugins()).filter(entry => !entry.source.startsWith("builtin:"));
  const builtin = (id: string, config: Record<string, unknown> = {}): ManagedPlugin => ({ source: `builtin:${id}`, path: join(currentRelease, "plugins", id), enabled: true, config });
  await savePlugins([...entries, builtin("context-files", { workspacePath: workspace }), builtin("people", { workspacePath: workspace, recentTurns: 8, inlineLimit: 12_000 }), builtin("memory", { workspacePath: workspace }), builtin("scheduler", { timezone: process.env.TZ || "Asia/Taipei" }), builtin("subagent")]);
}

async function writeLaunchers(): Promise<void> {
  await mkdir(join(home, "bin"), { recursive: true, mode: 0o700 });
  const launcher = (entry: string) => `#!/bin/sh\nexport UMIRO_HOME=\"\${UMIRO_HOME:-${home}}\"\nexec \"${process.execPath}\" \"$UMIRO_HOME/app/current/${entry}\" \"$@\"\n`;
  await writeFile(join(home, "bin", "umiro"), launcher("cli/dist/src/main.js"), { mode: 0o700 });
  await writeFile(join(home, "bin", "umiro-gateway"), launcher("gateway/dist/src/main.js"), { mode: 0o700 });
  await chmod(join(home, "bin", "umiro"), 0o700); await chmod(join(home, "bin", "umiro-gateway"), 0o700);
}

const unitPath = join(home, "state", "umiro.service");
async function installService(): Promise<boolean> {
  const unit = `[Unit]\nDescription=Umiro Discord Agent\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=UMIRO_HOME=${home}\nEnvironmentFile=-${secretsFile}\nWorkingDirectory=${workspace}\nExecStart=${join(home, "bin", "umiro-gateway")}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(join(home, "state"), { recursive: true, mode: 0o700 }); await writeFile(unitPath, unit, { mode: 0o600 });
  if (process.env.UMIRO_NO_SYSTEMD === "1") return false;
  try { await exec("systemctl", ["--user", "link", unitPath]); await exec("systemctl", ["--user", "daemon-reload"]); await exec("systemctl", ["--user", "enable", "umiro.service"]); return true; } catch { return false; }
}

async function install(): Promise<void> {
  for (const name of ["bin", "app", "config", "workspace", "data", "state"]) await mkdir(join(home, name), { recursive: true, mode: 0o700 });
  await init(); const release = await deployRelease(); await registerBuiltins(); await writeLaunchers(); const systemd = await installService();
  console.log(`installed ${release}${systemd ? " (systemd user service enabled)" : " (daemon fallback available)"}`);
}

async function configure(fromEnv?: string): Promise<void> {
  if (!fromEnv) throw new Error("configure requires --from-env <path>"); const source = resolve(fromEnv); await access(source); await mkdir(dirname(secretsFile), { recursive: true, mode: 0o700 }); let content = await readFile(source, "utf8"); if (!/^UMIRO_WEB_UI_TOKEN=/m.test(content)) content = `${content.trimEnd()}\nUMIRO_WEB_UI_TOKEN=${randomBytes(32).toString("hex")}\n`; await writeFile(secretsFile, content, { mode: 0o600 }); await chmod(secretsFile, 0o600); console.log(secretsFile);
}

async function embedding(action: string, provider?: string, model?: string, baseUrl?: string, apiKeyEnv?: string): Promise<void> {
  const config = await loadConfig();
  if (action === "status") { console.log(JSON.stringify(config.embedding ?? { provider: "disabled" }, null, 2)); return; }
  if (action === "disable") { await saveConfig({ ...config, embedding: { provider: "disabled" } }); console.log("embedding disabled"); return; }
  if (action !== "configure") throw new Error("usage: umiro embedding configure|disable|status");
  if (provider !== "gemini" && provider !== "openai-compatible") throw new Error("--provider must be gemini or openai-compatible");
  if (!model?.trim()) throw new Error("embedding configure requires --model");
  if (provider === "openai-compatible" && !baseUrl?.trim()) throw new Error("openai-compatible embedding requires --base-url");
  const next = provider === "gemini"
    ? { provider, model: model.trim(), apiKeyEnv: apiKeyEnv?.trim() || "GOOGLE_API_KEY" }
    : { provider, model: model.trim(), baseUrl: baseUrl!.trim(), ...(apiKeyEnv?.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}) };
  await saveConfig({ ...config, embedding: next });
  console.log(`embedding configured: ${provider}/${model.trim()}`);
}

function commaList(value: string | undefined, current: unknown): readonly string[] {
  if (value === undefined) return Array.isArray(current) ? current.filter(item => typeof item === "string") : [];
  return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
}

async function discord(action: string, options: { ignoredChannels: string | undefined; ambientChannels: string | undefined; allowedChannels: string | undefined; allowedGuilds: string | undefined; respondToBots: string | undefined }): Promise<void> {
  const config = await loadConfig();
  const current = config.discord ?? {};
  if (action === "status") { console.log(JSON.stringify(current, null, 2)); return; }
  if (action !== "configure") throw new Error("usage: umiro discord configure|status");
  if (options.respondToBots !== undefined && options.respondToBots !== "true" && options.respondToBots !== "false") throw new Error("--respond-to-bots must be true or false");
  const next = {
    ignoredChannels: commaList(options.ignoredChannels, current.ignoredChannels),
    ambientChannels: commaList(options.ambientChannels, current.ambientChannels),
    allowedChannels: commaList(options.allowedChannels, current.allowedChannels),
    allowedGuilds: commaList(options.allowedGuilds, current.allowedGuilds),
    respondToBots: options.respondToBots === undefined ? current.respondToBots === true : options.respondToBots === "true",
  };
  await saveConfig({ ...config, discord: next });
  console.log("discord trigger policy configured");
}

async function web(action: string): Promise<void> {
  if (action === "status") { const config = await loadConfig(); console.log(JSON.stringify(config.webUi ?? { enabled: false }, null, 2)); return; }
  if (action === "token") { const content = await readFile(secretsFile, "utf8"); const token = /^UMIRO_WEB_UI_TOKEN=(.+)$/m.exec(content)?.[1]?.trim(); if (!token) throw new Error("Web UI token is not configured"); console.log(token); return; }
  throw new Error("usage: umiro web status|token");
}

const pidFile = join(home, "state", "gateway.pid.json");
async function fallbackProcess(): Promise<{ pid: number; entry: string } | undefined> { try { const state = JSON.parse(await readFile(pidFile, "utf8")) as { pid: number; entry: string }; process.kill(state.pid, 0); const command = await readFile(`/proc/${state.pid}/cmdline`, "utf8"); if (!command.includes(state.entry)) return undefined; return state; } catch { return undefined; } }
async function systemdActive(): Promise<boolean> { if (process.env.UMIRO_NO_SYSTEMD === "1") return false; try { return (await exec("systemctl", ["--user", "is-active", "umiro.service"])).stdout.trim() === "active"; } catch { return false; } }
async function status(): Promise<boolean> {
  if (await systemdActive()) { console.log("running (systemd)"); return true; }
  const fallback = await fallbackProcess(); if (fallback) { console.log(`running ${fallback.pid}`); return true; }
  console.log("stopped"); return false;
}
async function start(): Promise<void> {
  if (await status()) return; if (!await exists(join(currentRelease, "gateway", "dist", "src", "main.js"))) await install();
  if (process.env.UMIRO_NO_SYSTEMD !== "1") { try { await exec("systemctl", ["--user", "start", "umiro.service"]); await new Promise(resolveWait => setTimeout(resolveWait, 750)); if (await systemdActive()) { console.log("started (systemd)"); return; } } catch { /* fallback */ } }
  const entry = resolve(process.env.UMIRO_GATEWAY_ENTRY?.trim() || join(currentRelease, "gateway", "dist", "src", "main.js")); const logPath = join(home, "state", "gateway.log"); const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, UMIRO_HOME: home } }); child.unref(); if (!child.pid) throw new Error("gateway failed to start");
  await writeFile(pidFile, `${JSON.stringify({ pid: child.pid, entry, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 }); await new Promise(resolveWait => setTimeout(resolveWait, 500));
  try { process.kill(child.pid, 0); } catch { throw new Error(`gateway exited during startup; inspect ${logPath}`); }
  console.log(`started ${child.pid}`);
}
async function stop(): Promise<void> {
  if (await systemdActive()) { await exec("systemctl", ["--user", "stop", "umiro.service"]); console.log("stopped (systemd)"); return; }
  const processState = await fallbackProcess(); if (processState) process.kill(processState.pid, "SIGTERM"); await rm(pidFile, { force: true }); console.log("stopped");
}
async function rollback(): Promise<void> {
  const current = await readlink(currentRelease); const releases = (await readdir(join(app, "releases"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse(); const currentName = current.split("/").pop(); const previous = releases.find(name => name !== currentName); if (!previous) throw new Error("no previous release available");
  const temporaryLink = join(app, `.current-${crypto.randomUUID()}`); await symlink(join("releases", previous), temporaryLink); await rename(temporaryLink, currentRelease); await registerBuiltins(); await writeLaunchers(); console.log(`rolled back to ${previous}`);
}

async function backup(destination?: string): Promise<void> {
  if (!destination) throw new Error("backup requires a destination directory");
  if (await systemdActive() || await fallbackProcess()) throw new Error("stop the daemon before creating a backup");
  const target = resolve(destination); await mkdir(target, { recursive: true, mode: 0o700 });
  await access(join(home, "data", "umiro.sqlite"));
  await cp(join(home, "data", "umiro.sqlite"), join(target, "umiro.sqlite"));
  if (await exists(join(home, "data", "artifacts"))) await cp(join(home, "data", "artifacts"), join(target, "artifacts"), { recursive: true });
  await writeFile(join(target, "backup.json"), `${JSON.stringify({ format: 1, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(target);
}

async function restore(source?: string): Promise<void> {
  if (!source) throw new Error("restore requires a backup directory");
  if (await systemdActive() || await fallbackProcess()) throw new Error("stop the daemon before restoring a backup");
  const sourceRoot = resolve(source); await access(join(sourceRoot, "umiro.sqlite"));
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

async function plugin(action: string, source?: string, workspaceName?: string, configJson?: string): Promise<void> {
  const entries = await loadPlugins(); if (action === "list") { console.log(entries.map(item => `${item.enabled ? "enabled" : "disabled"}\t${item.source}${item.workspace ? `#${item.workspace}` : ""}`).join("\n")); return; } if (!source) throw new Error(`plugin ${action} requires a path`);
  let path = resolve(source); const installing = action === "install" || action === "update";
  if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(source)) {
    const repo = source.replace(/\/$/, "").split("/").pop()!.replace(/\.git$/, ""); path = managedPluginPath(join(app, "plugins"), repo, workspaceName);
    if (installing) {
      const pluginRoot = join(app, "plugins"); const nonce = crypto.randomUUID(); const checkout = join(pluginRoot, `.checkout-${nonce}`); const candidate = join(pluginRoot, `.candidate-${nonce}`); const previous = join(pluginRoot, `.previous-${nonce}`);
      await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
      try {
        await exec("git", ["clone", "--depth", "1", source, checkout]);
        if (workspaceName) { const direct = join(checkout, workspaceName); const nested = join(checkout, "packages", workspaceName); const selected = await exists(join(direct, "package.json")) ? direct : nested; await access(join(selected, "package.json")); await cp(selected, candidate, { recursive: true }); }
        else await rename(checkout, candidate);
        const manager = await exists(join(candidate, "pnpm-lock.yaml")) ? "pnpm" : "npm"; await exec(manager, manager === "pnpm" ? ["install", "--frozen-lockfile"] : ["install", "--ignore-scripts"], { cwd: candidate }); await exec(manager, ["run", "build"], { cwd: candidate });
        await validatePluginDirectory(candidate);
        const replacing = await exists(path); if (replacing) await rename(path, previous);
        try { await rename(candidate, path); } catch (error) { if (replacing) await rename(previous, path); throw error; }
        await rm(previous, { recursive: true, force: true });
      } finally { await rm(checkout, { recursive: true, force: true }); await rm(candidate, { recursive: true, force: true }); }
    }
  } else if (installing && /^(?:https?|git):/.test(source)) throw new Error("only public GitHub HTTPS plugin URLs are supported");
  if (installing) await validatePluginDirectory(path);
  const matches = (item: ManagedPlugin) => item.path === path || (item.source === source && item.workspace === workspaceName);
  if (!installing && !entries.some(matches)) throw new Error(`plugin is not installed: ${source}${workspaceName ? `#${workspaceName}` : ""}`);
  let next = entries;
  if (installing) { const previousEntry = entries.find(matches); next = [...entries.filter(item => !matches(item)), { source, path, ...(workspaceName ? { workspace: workspaceName } : {}), enabled: previousEntry?.enabled ?? true, ...(previousEntry?.config ? { config: previousEntry.config } : {}) }]; }
  else if (action === "remove") next = entries.filter(item => !matches(item));
  else if (action === "enable" || action === "disable") next = entries.map(item => matches(item) ? { ...item, enabled: action === "enable" } : item);
  else if (action === "configure") next = entries.map(item => matches(item) ? { ...item, config: JSON.parse(configJson ?? "{}") as Record<string, unknown> } : item);
  else throw new Error(`unsupported plugin action: ${action}`);
  await savePlugins(next); if (action === "remove" && path.startsWith(`${join(app, "plugins")}/`) && !source.startsWith("builtin:")) await rm(path, { recursive: true, force: true }); console.log(`${action}: ${path}`);
}

const args = process.argv.slice(2).filter((value, index) => value !== "--" || index > 0); const [command, action, source] = args; const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
if (command === "install" || command === "upgrade") await install(); else if (command === "init") await init(); else if (command === "configure") await configure(option("--from-env")); else if (command === "embedding") await embedding(action ?? "status", option("--provider"), option("--model"), option("--base-url"), option("--api-key-env")); else if (command === "discord") await discord(action ?? "status", { ignoredChannels: option("--ignored-channels"), ambientChannels: option("--ambient-channels"), allowedChannels: option("--allowed-channels"), allowedGuilds: option("--allowed-guilds"), respondToBots: option("--respond-to-bots") }); else if (command === "web") await web(action ?? "status"); else if (command === "start") await start(); else if (command === "stop") await stop(); else if (command === "status") await status(); else if (command === "rollback") await rollback(); else if (command === "backup") await backup(action); else if (command === "restore") await restore(action); else if (command === "plugin") await plugin(action ?? "list", source, option("--workspace"), option("--config")); else throw new Error("usage: umiro install|upgrade|rollback|backup DIR|restore DIR|init|configure --from-env .env|embedding configure|disable|status|discord configure|status|web status|token|start|stop|status|plugin ...");
