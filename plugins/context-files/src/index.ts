import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ContextProvider, ContextRole } from "@umiro/core/context";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";

interface ContextFilesConfig {
  readonly workspacePath: string;
}

const FILES: Readonly<Record<"soul" | "agent" | "owner" | "memory", string>> = {
  soul: "SOUL.md",
  agent: "AGENT.md",
  owner: "OWNER.md",
  memory: "MEMORY.md",
};

const PRIORITY: Readonly<Record<"soul" | "agent" | "owner" | "memory", number>> = {
  soul: 100,
  agent: 200,
  owner: 250,
  memory: 300,
};

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function provider(
  role: "soul" | "agent" | "owner" | "memory",
  config: ContextFilesConfig,
  getRoot: () => string,
): ContextProvider {
  const id = `context.${role}`;
  return {
    id,
    role: role satisfies ContextRole,
    priority: PRIORITY[role],
    async load(request) {
      const path = join(getRoot(), FILES[role]);
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`context source must be a regular non-symlink file: ${path}`);
        const content = await readFile(path, "utf8");
        if (!content.trim()) return [];
        return [{
          id: `${id}:file`,
          providerId: id,
          role,
          content,
          source: { kind: "file", ref: path },
          influence: "information",
          instructionAuthority: "none",
        }];
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
  };
}

export function createPlugin(context: PluginSetupContext): PluginInstance {
  const config = context.config as unknown as ContextFilesConfig;
  let workspaceRoot = "";
  return {
    contributions: {
      contextProviders: [
        provider("soul", config, () => workspaceRoot),
        provider("agent", config, () => workspaceRoot),
        provider("owner", config, () => workspaceRoot),
        provider("memory", config, () => workspaceRoot),
      ],
    },
    async start() {
      const configured = await lstat(config.workspacePath);
      if (configured.isSymbolicLink()) throw new Error(`context workspace cannot be a symlink: ${config.workspacePath}`);
      workspaceRoot = await realpath(config.workspacePath);
      const stat = await lstat(workspaceRoot);
      if (!stat.isDirectory()) {
        throw new Error(`context workspace must be a regular directory: ${config.workspacePath}`);
      }
    },
  };
}
