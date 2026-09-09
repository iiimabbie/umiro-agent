import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const home = resolve(process.env.UMIRO_HOME?.trim() || join(homedir(), ".umiro-v2"));
const workspace = join(home, "workspace");
const plugins = join(home, "config", "plugins.json");
const templates = resolve(new URL("../../../../templates/workspace", import.meta.url).pathname);

async function init(): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const name of ["SOUL.md", "AGENT.md", "MEMORY.md", "PEOPLE.md"]) {
    try { await readFile(join(workspace, name)); } catch { await cp(join(templates, name), join(workspace, name)); }
  }
  await mkdir(join(home, "config"), { recursive: true, mode: 0o700 });
  try { await readFile(plugins); } catch { await writeFile(plugins, "[]\n", { mode: 0o600 }); }
  console.log(home);
}

async function plugin(action: string, source?: string): Promise<void> {
  const entries: string[] = JSON.parse(await readFile(plugins, "utf8"));
  if (action === "list") { console.log(entries.join("\n")); return; }
  if (!source) throw new Error(`plugin ${action} requires a path`);
  const path = resolve(source);
  const next = action === "install" ? [...new Set([...entries, path])] : entries.filter(item => item !== path);
  await writeFile(plugins, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  if (action === "remove") await rm(join(home, "data", "plugins", path), { recursive: true, force: true });
  console.log(`${action}: ${path}`);
}

const [command, action, source] = process.argv.slice(2);
if (command === "init") await init();
else if (command === "plugin") await plugin(action ?? "list", source);
else throw new Error("usage: umiro init | umiro plugin install <path> | umiro plugin list | umiro plugin remove <path>");
