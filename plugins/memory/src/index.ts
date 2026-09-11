import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "@umiro/core/ports";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "@umiro/core/tool";

interface MemoryConfig { readonly workspacePath: string; readonly characterLimit?: number }
const DEFAULT_CHARACTER_LIMIT = 3_000;
const ok = (output: unknown): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus: "confirmed" });
const failed = (error: unknown): ToolExecutionResult => ({ ok: false, effectStatus: "not_applicable", error: { code: "memory_error", message: error instanceof Error ? error.message : String(error), retryable: false } });

export function createPlugin(setup: PluginSetupContext): PluginInstance {
  const config = setup.config as unknown as MemoryConfig; let root = ""; let queue = Promise.resolve();
  const path = () => join(root, "MEMORY.md");
  const read = async () => readFile(path(), "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "# MEMORY\n"; throw error; });
  const publish = async () => { const search = setup.services?.searchDocuments; if (!search) return; const content = await read(); await search.replaceSource("MEMORY.md", [{ id: "MEMORY.md", sourceType: "workspace_file", sourceId: "MEMORY.md", text: content, visibility: { kind: "all" } }]); };
  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => { const previous = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } };
  const limit = config.characterLimit ?? DEFAULT_CHARACTER_LIMIT;
  const usage = (chars: number) => ({ chars, limit, percent: Math.round((chars / limit) * 100) });
  const write = async (content: string) => {
    const normalized = `${content.trim()}\n`; const currentUsage = usage(normalized.length);
    if (normalized.length > limit) throw new Error(`MEMORY.md would exceed character limit. [${currentUsage.chars}/${limit} chars, ${currentUsage.percent}%] — consolidate existing entries first with memory_replace or memory_remove.`);
    const temporary = `${path()}.${process.pid}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, normalized, { mode: 0o600 }); await rename(temporary, path()); await publish();
    return currentUsage;
  };
  const define = (definition: Omit<ToolDefinition, "execute"> & { execute: (input: JsonObject, context: ToolExecutionContext) => Promise<unknown> }): ToolDefinition => ({ ...definition, async execute(input, context) { try { return ok(await definition.execute(input, context)); } catch (error) { return failed(error); } } });
  const tools: ToolDefinition[] = [
    define({ name: "memory_search", description: "Permission-aware full-text search over durable prior conversation turns.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 } } }, policy: { capability: "memory.search", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute(input, context) {
      const search = setup.services?.conversationSearch; if (!search) throw new Error("conversation search service is unavailable");
      const hits = await search.search(String(input.query), typeof input.limit === "number" ? input.limit : 10, context.execution.authority.visibility);
      return { hits: hits.map(hit => ({ turnId: hit.turnId, conversationId: hit.conversationId, actorPrincipalId: hit.actorPrincipalId, text: hit.text, rank: hit.rank })) };
    } }),
    define({ name: "memory_add", description: "Append durable shared operating context to MEMORY.md.", inputSchema: { type: "object", additionalProperties: false, required: ["content"], properties: { content: { type: "string", minLength: 1 } } }, policy: { capability: "memory.write", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input) {
      return serialized(async () => { const current = await read(); const content = String(input.content).trim(); if (current.includes(content)) return { added: false, reason: "already_present", usage: usage(`${current.trim()}\n`.length) }; const nextUsage = await write(`${current.trim()}\n\n${content}`); return { added: true, usage: nextUsage }; });
    } }),
    define({ name: "memory_replace", description: "Replace one exact occurrence in MEMORY.md.", inputSchema: { type: "object", additionalProperties: false, required: ["oldText", "newText"], properties: { oldText: { type: "string", minLength: 1 }, newText: { type: "string" } } }, policy: { capability: "memory.write", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input) {
      return serialized(async () => { const current = await read(); const oldText = String(input.oldText); const count = current.split(oldText).length - 1; if (count !== 1) throw new Error(count ? "oldText must match exactly once" : "oldText not found"); const nextUsage = await write(current.replace(oldText, String(input.newText))); return { replaced: true, usage: nextUsage }; });
    } }),
    define({ name: "memory_remove", description: "Remove one exact occurrence from MEMORY.md. Owner only.", inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1 } } }, policy: { capability: "memory.remove", tier: "privileged", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input) {
      return serialized(async () => { const current = await read(); const text = String(input.text); const count = current.split(text).length - 1; if (count !== 1) throw new Error(count ? "text must match exactly once" : "text not found"); const nextUsage = await write(current.replace(text, "").replace(/\n{3,}/g, "\n\n")); return { removed: true, usage: nextUsage }; });
    } }),
  ];
  return { contributions: { tools }, async start() { const stat = await lstat(config.workspacePath); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`memory workspace must be a regular directory: ${config.workspacePath}`); root = await realpath(config.workspacePath); await publish(); } };
}
