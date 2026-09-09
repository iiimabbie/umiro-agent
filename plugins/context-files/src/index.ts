import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "@umiro/core/ports";
import type { ContextProvider, ContextRole } from "@umiro/core/context";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { ToolDefinition, ToolExecutionResult } from "@umiro/core/tool";

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
          influence: role === "soul" || role === "agent" ? "instruction" : "information",
          instructionAuthority: role === "soul" || role === "agent" ? "full" : "none",
          retention: role === "soul" || role === "agent" || role === "owner" ? "essential" : "normal",
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
  let workspaceRoot = ""; let writeQueue = Promise.resolve();
  const ownerPath = () => join(workspaceRoot, "OWNER.md");
  const ownerWrite = async (content: string) => { const normalized = `${content.trim()}\n`; if (normalized.length > 20_000) throw new Error("OWNER.md exceeds 20000 characters"); const temporary = `${ownerPath()}.${process.pid}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, normalized, { mode: 0o600 }); await rename(temporary, ownerPath()); };
  const serial = async <T>(operation: () => Promise<T>): Promise<T> => { const previous = writeQueue; let release!: () => void; writeQueue = new Promise<void>(resolve => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } };
  const result = (output: unknown): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus: "confirmed" });
  const failure = (error: unknown): ToolExecutionResult => ({ ok: false, effectStatus: "not_applicable", error: { code: "owner_profile_error", message: error instanceof Error ? error.message : String(error), retryable: false } });
  const tool = (name: string, description: string, inputSchema: JsonObject, execute: (input: JsonObject) => Promise<unknown>): ToolDefinition => ({ name, description, inputSchema, policy: { capability: "owner.profile.write", tier: "privileged", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input) { try { return result(await execute(input)); } catch (error) { return failure(error); } } });
  const tools = [
    tool("owner_profile_add", "Append one durable fact to OWNER.md. Owner only.", { type: "object", additionalProperties: false, required: ["content"], properties: { content: { type: "string", minLength: 1 } } }, async input => serial(async () => { const current = await readFile(ownerPath(), "utf8").catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? "# OWNER\n" : Promise.reject(error)); const content = String(input.content).trim(); if (current.includes(content)) return { added: false }; await ownerWrite(`${current.trim()}\n\n${content}`); return { added: true }; })),
    tool("owner_profile_replace", "Replace one exact occurrence in OWNER.md. Owner only.", { type: "object", additionalProperties: false, required: ["oldText", "newText"], properties: { oldText: { type: "string", minLength: 1 }, newText: { type: "string" } } }, async input => serial(async () => { const current = await readFile(ownerPath(), "utf8"); const oldText = String(input.oldText); if (current.split(oldText).length !== 2) throw new Error("oldText must match exactly once"); await ownerWrite(current.replace(oldText, String(input.newText))); return { replaced: true }; })),
  ];
  const history: ContextProvider = { id: "context.conversation_history", role: "conversation-history", priority: 700, async load(request) { const items = request.recentHistory ?? []; if (!items.length) return []; const lines = items.flatMap(item => { const user = item.turn.content.filter(block => block.type === "text").map(block => block.text).join("\n"); return [`User (${item.turn.actorPrincipalId}): ${user}`, ...(item.assistantText ? [`Assistant: ${item.assistantText}`] : [])]; }); return [{ id: "context.conversation_history:recent", providerId: "context.conversation_history", role: "conversation-history", content: `<conversation-history>\n${lines.join("\n")}\n</conversation-history>`, source: { kind: "conversation", ref: items[0]!.turn.conversationId }, influence: "information", instructionAuthority: "none" }]; } };
  return {
    contributions: {
      contextProviders: [
        provider("soul", config, () => workspaceRoot),
        provider("agent", config, () => workspaceRoot),
        provider("owner", config, () => workspaceRoot),
        provider("memory", config, () => workspaceRoot),
        history,
      ],
      tools,
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
