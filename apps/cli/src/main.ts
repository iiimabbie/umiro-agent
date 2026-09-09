import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const home = resolve(process.env.UMIRO_HOME?.trim() || join(homedir(), ".umiro-v2"));
const workspace = join(home, "workspace");
const plugins = join(home, "config", "plugins.json");
const configFile = join(home, "config", "umiro.json");
const templates = resolve(new URL("../../../../templates/workspace", import.meta.url).pathname);
const exec = promisify(execFile);

async function init(): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const name of ["SOUL.md", "AGENT.md", "MEMORY.md", "PEOPLE.md"]) {
    try { await readFile(join(workspace, name)); } catch { await cp(join(templates, name), join(workspace, name)); }
  }
  await mkdir(join(home, "config"), { recursive: true, mode: 0o700 });
  try { await readFile(plugins); } catch { await writeFile(plugins, "[]\n", { mode: 0o600 }); }
  try { await readFile(configFile); } catch { await writeFile(configFile, `${JSON.stringify({ model: process.env.LLM_MODEL?.trim() || "gemma4:31b", plugins: [] }, null, 2)}\n`, { mode: 0o600 }); }
  console.log(home);
}

async function install(): Promise<void> {
  for (const name of ["bin", "app", "config", "workspace", "data", "state"]) await mkdir(join(home, name), { recursive: true, mode: 0o700 });
  await init();
}

const pidFile = join(home, "state", "gateway.pid");
async function status(): Promise<boolean> {
  try {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    process.kill(pid, 0);
    console.log(`running ${pid}`);
    return true;
  } catch { console.log("stopped"); return false; }
}

async function start(): Promise<void> {
  if (await status()) return;
  await install();
  const entry = resolve(process.env.UMIRO_GATEWAY_ENTRY?.trim() || new URL("../../../gateway/dist/src/main.js", import.meta.url).pathname);
  const log = openSync(join(home, "state", "gateway.log"), "a", 0o600);
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, UMIRO_HOME: home } });
  child.unref();
  if (!child.pid) throw new Error("gateway failed to start");
  await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
  console.log(`started ${child.pid}`);
}

async function stop(): Promise<void> {
  try {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    process.kill(pid, "SIGTERM");
    await rm(pidFile, { force: true });
    console.log(`stopped ${pid}`);
  } catch { await rm(pidFile, { force: true }); console.log("stopped"); }
}

async function plugin(action: string, source?: string, workspaceName?: string): Promise<void> {
  const entries: string[] = JSON.parse(await readFile(plugins, "utf8"));
  if (action === "list") { console.log(entries.join("\n")); return; }
  if (!source) throw new Error(`plugin ${action} requires a path`);
  let path = resolve(source);
  if (action === "install" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(source)) {
    const repo = source.replace(/\/$/, "").split("/").pop()!.replace(/\.git$/, "");
    path = join(home, "app", "plugins", workspaceName ? `${repo}-${workspaceName}` : repo);
    const cloneRoot = workspaceName ? `${path}.checkout` : path;
    await mkdir(join(home, "app", "plugins"), { recursive: true, mode: 0o700 });
    await rm(path, { recursive: true, force: true });
    await rm(cloneRoot, { recursive: true, force: true });
    await exec("git", ["clone", "--depth", "1", source, cloneRoot]);
    if (workspaceName) {
      const packageRoot = join(cloneRoot, workspaceName);
      const packagesRoot = join(cloneRoot, "packages", workspaceName);
      try { await readFile(join(packageRoot, "package.json")); }
      catch { await readFile(join(packagesRoot, "package.json")); }
      await cp((await readFile(join(packageRoot, "package.json")).then(() => packageRoot).catch(() => packagesRoot)), path, { recursive: true });
      await rm(cloneRoot, { recursive: true, force: true });
    }
    try {
      await readFile(join(path, "umiro.plugin.json"), "utf8");
    } catch {
      try {
        const packageJson = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { umiro?: { plugin?: string } };
        if (!packageJson.umiro?.plugin) throw new Error("missing umiro plugin entry");
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw new Error(`cloned repository is not a Umiro Plugin: ${source}`, { cause: error });
      }
    }
    try {
      await readFile(join(path, "package.json"), "utf8");
      const lock = await readFile(join(path, "pnpm-lock.yaml"), "utf8").then(() => "pnpm").catch(() => "npm");
      await exec(lock, lock === "pnpm" ? ["install", "--frozen-lockfile"] : ["install", "--ignore-scripts"], { cwd: path });
      await exec("pnpm", ["run", "build"], { cwd: path });
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw new Error(`plugin dependency install/build failed: ${source}`, { cause: error });
    }
  } else if (action !== "install" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(source)) {
    const repo = source.replace(/\/$/, "").split("/").pop()!.replace(/\.git$/, "");
    path = join(home, "app", "plugins", workspaceName ? `${repo}-${workspaceName}` : repo);
  } else if (action === "install" && /^(?:https?|git):/.test(source)) {
    throw new Error("only public GitHub HTTPS plugin URLs are supported");
  }
  if (action === "install") {
    try { await readFile(join(path, "umiro.plugin.json"), "utf8"); }
    catch {
      const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { umiro?: { plugin?: string } };
      if (!pkg.umiro?.plugin) throw new Error(`plugin manifest not found: ${path}`);
    }
  }
  const next = action === "install" ? [...new Set([...entries, path])] : entries.filter(item => item !== path);
  await writeFile(plugins, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  if (action === "remove" && path.startsWith(`${join(home, "app", "plugins")}/`)) {
    await rm(path, { recursive: true, force: true });
  }
  console.log(`${action}: ${path}`);
}

const args = process.argv.slice(2);
const [command, action, source] = args;
const workspaceIndex = args.indexOf("--workspace");
const workspaceName = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
if (command === "install") await install();
else if (command === "init") await init();
else if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "status") await status();
else if (command === "plugin") await plugin(action ?? "list", source, workspaceName);
else throw new Error("usage: umiro install|init|start|stop|status | umiro plugin install <source> [--workspace name] | list | remove <source>");
