import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { JsonObject } from "@umiro/core/ports";
import type { PluginLogger } from "@umiro/core/plugin";
import type { ToolDefinition, ToolExecutionResult } from "@umiro/core/tool";

const run = promisify(execFile);
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function safeName(value: string): string {
  const name = value.trim();
  if (!SKILL_NAME.test(name) || name === "." || name === "..") throw new Error("skill name must be one safe directory segment");
  return name;
}

function defaultName(source: string): string {
  const tail = basename(source.replace(/[\\/]+$/, "")).replace(/\.git$/i, "");
  if (!tail) throw new Error("skill name cannot be derived from source");
  return safeName(tail);
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

export function parseSkillFrontmatter(content: string): { readonly name?: string; readonly description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if ((key === "name" || key === "description") && value) values[key] = value;
  }
  return { ...(values.name ? { name: values.name } : {}), ...(values.description ? { description: values.description } : {}) };
}

async function skillDescription(directory: string): Promise<string> {
  const skillFile = join(directory, "SKILL.md");
  const stat = await lstat(skillFile).catch(error => {
    if (isMissing(error)) throw new Error("installed source must contain a regular SKILL.md file");
    throw error;
  });
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("installed source must contain a regular SKILL.md file");
  return parseSkillFrontmatter(await readFile(skillFile, "utf8")).description ?? "(no description)";
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}

async function moveToTrash(workspaceRoot: string, path: string, name: string): Promise<string> {
  const trash = join(workspaceRoot, ".trash");
  await mkdir(trash, { recursive: true, mode: 0o700 });
  const destination = join(trash, `skill-${name}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await rename(path, destination);
  return destination;
}

async function persistEnabledSkills(configFile: string, enabled: ReadonlySet<string>): Promise<void> {
  const raw = JSON.parse(await readFile(configFile, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Umiro config must be a JSON object");
  const next = { ...raw, skills: [...enabled].sort() };
  const temporary = join(dirname(configFile), `.umiro-skills-${randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, configFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

function success(output: JsonObject, changed: boolean): ToolExecutionResult {
  return { ok: true, output, effectStatus: changed ? "confirmed" : "not_applicable" };
}

function failure(code: string, error: unknown, effectStatus: "not_applicable" | "unknown" = "not_applicable"): ToolExecutionResult {
  return { ok: false, effectStatus, error: { code, message: error instanceof Error ? error.message : String(error), retryable: false } };
}

export function createSkillTools(options: {
  readonly workspaceRoot: () => string;
  readonly configFile?: string;
  readonly enabled: Set<string>;
  readonly serial: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly logger?: PluginLogger;
}): readonly ToolDefinition[] {
  const roots = () => ({ workspace: options.workspaceRoot(), skills: join(options.workspaceRoot(), "skills") });
  const requireConfig = (): string => {
    if (!options.configFile) throw new Error("skill management config path is unavailable");
    return options.configFile;
  };

  const install: ToolDefinition = {
    name: "skill_install",
    description: "Install and immediately enable a skill from a Git URL or local directory. The source root must contain SKILL.md. Owner only.",
    inputSchema: { type: "object", additionalProperties: false, required: ["source"], properties: { source: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 } } },
    policy: { capability: "skill.manage", tier: "privileged", interactionRequirement: "not_required", sideEffect: "idempotent", timeoutMs: 60_000 },
    async execute(input) {
      try {
        return await options.serial(async () => {
          const source = String(input.source);
          const name = safeName(typeof input.name === "string" ? input.name : defaultName(source));
          const { workspace, skills } = roots();
          const destination = join(skills, name);
          const staged = join(skills, `.install-${name}-${randomUUID()}`);
          await mkdir(skills, { recursive: true, mode: 0o700 });
          if (await pathExists(destination)) return success({ installed: false, name, reason: "already_exists" }, false);
          let moved = false;
          try {
            const sourcePath = resolve(source);
            const local = await lstat(sourcePath).then(stat => stat.isDirectory()).catch(error => isMissing(error) ? false : Promise.reject(error));
            if (local) {
              const realSource = await realpath(sourcePath);
              const realSkills = await realpath(skills);
              if (isInside(realSource, realSkills)) throw new Error("local source cannot contain workspace/skills");
              await cp(realSource, staged, { recursive: true, errorOnExist: true });
            } else {
              if (source.startsWith("-")) throw new Error("Git source cannot begin with '-'");
              try {
                await run("git", ["clone", "--depth", "1", "--", source, staged], { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
              } catch {
                throw new Error("Git clone failed");
              }
            }
            const description = await skillDescription(staged);
            await rename(staged, destination);
            moved = true;
            const next = new Set(options.enabled).add(name);
            await persistEnabledSkills(requireConfig(), next);
            options.enabled.add(name);
            options.logger?.info("skill.installed", "Workspace skill installed", { name });
            return success({ installed: true, name, description }, true);
          } catch (error) {
            if (await pathExists(staged)) await moveToTrash(workspace, staged, `${name}-install-failed`);
            if (moved && await pathExists(destination)) await moveToTrash(workspace, destination, `${name}-install-rollback`);
            throw error;
          }
        });
      } catch (error) { return failure("skill_install_error", error); }
    },
  };

  const uninstall: ToolDefinition = {
    name: "skill_uninstall",
    description: "Disable a skill and move its complete workspace directory to .trash so it remains recoverable. Owner only.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1 } } },
    policy: { capability: "skill.manage", tier: "privileged", interactionRequirement: "not_required", sideEffect: "idempotent" },
    async execute(input) {
      try {
        return await options.serial(async () => {
          const name = safeName(String(input.name));
          const { workspace, skills } = roots();
          const destination = join(skills, name);
          const present = await pathExists(destination);
          const active = options.enabled.has(name);
          if (!present && !active) return success({ uninstalled: false, name, reason: "not_installed" }, false);
          let trashed: string | undefined;
          try {
            if (present) trashed = await moveToTrash(workspace, destination, name);
            const next = new Set(options.enabled); next.delete(name);
            await persistEnabledSkills(requireConfig(), next);
            options.enabled.delete(name);
          } catch (error) {
            if (trashed && await pathExists(trashed) && !await pathExists(destination)) await rename(trashed, destination);
            throw error;
          }
          options.logger?.info("skill.uninstalled", "Workspace skill uninstalled", { name });
          return success({ uninstalled: true, name, directoryMovedToTrash: present }, true);
        });
      } catch (error) { return failure("skill_uninstall_error", error); }
    },
  };

  const list: ToolDefinition = {
    name: "skill_list",
    description: "List installed workspace skills, whether each is enabled, and its description.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    policy: { capability: "context.files.read", tier: "common", interactionRequirement: "not_required", sideEffect: "none", concurrency: "parallel_safe" },
    async execute() {
      try {
        const { skills } = roots();
        const entries = await readdir(skills, { withFileTypes: true }).catch(error => isMissing(error) ? [] : Promise.reject(error));
        const result = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          if (entry.name.startsWith(".") || !entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
          let description = "(no SKILL.md)";
          try { description = await skillDescription(join(skills, entry.name)); } catch (error) { if (!isMissing(error)) description = "(invalid SKILL.md)"; }
          result.push({ name: entry.name, enabled: options.enabled.has(entry.name), description });
        }
        return success({ skills: result }, false);
      } catch (error) { return failure("skill_list_error", error); }
    },
  };

  return [install, uninstall, list];
}
