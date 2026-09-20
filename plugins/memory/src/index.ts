import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "@umiro/core/ports";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "@umiro/core/tool";

interface MemoryConfig { readonly workspacePath: string; readonly characterLimit?: number }
const DEFAULT_CHARACTER_LIMIT = 4_000;
const ENTRY_CHARACTER_LIMIT = 1_500;
const HEADING_CHARACTER_LIMIT = 80;
const MEMORY_FILES = {
  PREFERENCES: "How the owner prefers work and responses to be handled.",
  LESSONS: "Lessons learned from mistakes and how to avoid repeating them.",
  WORKFLOWS: "Repeatable procedures that are worth following consistently.",
  ONGOING: "Current projects, commitments, and unfinished work.",
  FACTS: "Durable facts about the owner's world, systems, links, and identifiers.",
} as const;
type MemoryFile = keyof typeof MEMORY_FILES;
interface MemoryEntry { readonly heading: string; readonly content: string }
interface MemoryDocument { readonly preamble: string; readonly entries: readonly MemoryEntry[] }

const ok = (output: unknown, effectStatus: "not_applicable" | "confirmed"): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus });
const failed = (error: unknown): ToolExecutionResult => ({ ok: false, effectStatus: "not_applicable", error: { code: "memory_error", message: error instanceof Error ? error.message : String(error), retryable: false } });
const isMissing = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
const filename = (file: MemoryFile): string => `${file}.md`;
const initialDocument = (file: MemoryFile): string => `# ${file}\n\n${MEMORY_FILES[file]}\n`;

function selectedFile(value: unknown): MemoryFile {
  if (typeof value !== "string" || !Object.hasOwn(MEMORY_FILES, value)) throw new Error(`file must be one of: ${Object.keys(MEMORY_FILES).join(", ")}`);
  return value as MemoryFile;
}

function selectedHeading(value: unknown): string {
  const heading = typeof value === "string" ? value.trim() : "";
  if (!heading) throw new Error("heading must not be empty");
  if (heading.includes("\n") || heading.includes("\r")) throw new Error("heading must be one line");
  if (heading.length > HEADING_CHARACTER_LIMIT) throw new Error(`heading exceeds ${HEADING_CHARACTER_LIMIT} characters; shorten it and retry`);
  return heading;
}

function parseDocument(file: MemoryFile, source: string): MemoryDocument {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== `# ${file}`) throw new Error(`${filename(file)} must start with \"# ${file}\"`);
  const firstEntry = lines.findIndex((line, index) => index > 0 && line.startsWith("## "));
  const preambleLines = lines.slice(0, firstEntry < 0 ? lines.length : firstEntry);
  if (preambleLines.slice(1).some(line => line.startsWith("#"))) throw new Error(`${filename(file)} may only contain its # title before the first ## entry`);
  const prose = preambleLines.slice(1).join("\n").trim();
  if (prose && prose.split(/\n\s*\n/).length > 1) throw new Error(`${filename(file)} may only contain one introductory paragraph before its ## entries`);
  const entries: MemoryEntry[] = [];
  const seen = new Set<string>();
  if (firstEntry >= 0) {
    let heading = "";
    let content: string[] = [];
    const flush = () => {
      if (!heading) return;
      if (seen.has(heading)) throw new Error(`${filename(file)} contains duplicate heading: ${heading}`);
      seen.add(heading);
      entries.push({ heading, content: content.join("\n").trim() });
    };
    for (const line of lines.slice(firstEntry)) {
      if (line.startsWith("## ")) {
        flush();
        heading = selectedHeading(line.slice(3));
        content = [];
      } else content.push(line);
    }
    flush();
  }
  return { preamble: preambleLines.join("\n").trimEnd(), entries };
}

function renderDocument(document: MemoryDocument): string {
  const entries = document.entries.map(entry => `## ${entry.heading}\n${entry.content}`.trimEnd()).join("\n\n");
  return `${document.preamble.trimEnd()}${entries ? `\n\n${entries}` : ""}\n`;
}

export function createPlugin(setup: PluginSetupContext): PluginInstance {
  const config = setup.config as unknown as MemoryConfig;
  let root = "";
  let memoryRoot = "";
  let queue = Promise.resolve();
  const limit = config.characterLimit ?? DEFAULT_CHARACTER_LIMIT;
  const path = (file: MemoryFile) => join(memoryRoot, filename(file));
  const usage = (chars: number, entries: number) => ({ chars, limit, percent: Math.round((chars / limit) * 100), entries });
  const read = async (file: MemoryFile): Promise<{ source: string; document: MemoryDocument }> => {
    const target = path(file);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`memory file must be a regular non-symlink file: ${target}`);
    const source = await readFile(target, "utf8");
    return { source, document: parseDocument(file, source) };
  };
  const publish = async (file: MemoryFile, document?: MemoryDocument) => {
    const search = setup.services?.searchDocuments;
    if (!search) return;
    const parsed = document ?? (await read(file)).document;
    const group = `memory/${filename(file)}`;
    await search.replaceSource(group, parsed.entries.map(entry => {
      const sourceId = `${group}#${entry.heading}`;
      return { id: `entry:${createHash("sha256").update(sourceId).digest("hex")}`, sourceType: "workspace_file", sourceId, text: `${entry.heading}\n${entry.content}`.trim(), visibility: { kind: "all" } };
    }));
  };
  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => { const previous = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } };
  const atomicWrite = async (file: MemoryFile, document: MemoryDocument) => {
    const normalized = renderDocument(document);
    const currentUsage = usage(normalized.length, document.entries.length);
    if (normalized.length > limit) throw new Error(`${filename(file)} ${currentUsage.chars}/${limit} characters (${currentUsage.percent}%); first merge entries with memory_write or remove one with memory_remove`);
    const temporary = join(memoryRoot, `.${filename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, normalized, { mode: 0o600 });
      await rename(temporary, path(file));
    } finally { await rm(temporary, { force: true }); }
    await publish(file, document);
    return currentUsage;
  };
  const define = (definition: Omit<ToolDefinition, "execute"> & { execute: (input: JsonObject, context: ToolExecutionContext) => Promise<unknown> }): ToolDefinition => ({ ...definition, async execute(input, context) { try { return ok(await definition.execute(input, context), definition.policy.sideEffect === "none" ? "not_applicable" : "confirmed"); } catch (error) { return failed(error); } } });
  const tools: ToolDefinition[] = [
    define({ name: "memory_search", description: "Permission-aware full-text search over durable memories and prior conversation evidence.", inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 } } }, policy: { capability: "memory.search", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute(input, context) {
      const search = setup.services?.conversationSearch; if (!search) throw new Error("conversation search service is unavailable");
      const hits = await search.search(String(input.query), typeof input.limit === "number" ? input.limit : 10, context.execution.authority.visibility);
      return { hits: hits.map(hit => ({ turnId: hit.turnId, conversationId: hit.conversationId, actorPrincipalId: hit.actorPrincipalId, text: hit.text, rank: hit.rank, ...(hit.documentId ? { documentId: hit.documentId } : {}), ...(hit.sourceType ? { sourceType: hit.sourceType } : {}), ...(hit.sourceId ? { sourceId: hit.sourceId } : {}) })) };
    } }),
    define({ name: "memory_read", description: "Read one fixed memory file or one entry selected by heading.", inputSchema: { type: "object", additionalProperties: false, required: ["file"], properties: { file: { type: "string", enum: Object.keys(MEMORY_FILES) }, heading: { type: "string", minLength: 1, maxLength: HEADING_CHARACTER_LIMIT } } }, policy: { capability: "memory.search", tier: "common", interactionRequirement: "not_required", sideEffect: "none" }, async execute(input) {
      const file = selectedFile(input.file); const current = await read(file);
      if (input.heading === undefined) return { file, content: current.source, usage: usage(current.source.length, current.document.entries.length) };
      const heading = selectedHeading(input.heading); const entry = current.document.entries.find(candidate => candidate.heading === heading);
      if (!entry) throw new Error(`${filename(file)} has no heading \"${heading}\"; use memory_read without heading or memory_search`);
      return { file, heading, content: entry.content };
    } }),
    define({ name: "memory_write", description: "Create or replace one durable memory entry identified by its file and heading.", inputSchema: { type: "object", additionalProperties: false, required: ["file", "heading", "content"], properties: { file: { type: "string", enum: Object.keys(MEMORY_FILES) }, heading: { type: "string", minLength: 1, maxLength: HEADING_CHARACTER_LIMIT }, content: { type: "string", minLength: 1, maxLength: ENTRY_CHARACTER_LIMIT } } }, policy: { capability: "memory.write", tier: "common", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input) {
      return serialized(async () => {
        const file = selectedFile(input.file); const heading = selectedHeading(input.heading); const content = String(input.content).trim();
        if (!content) throw new Error("content must not be empty");
        if (content.length > ENTRY_CHARACTER_LIMIT) throw new Error(`content exceeds ${ENTRY_CHARACTER_LIMIT} characters; split it into focused entries`);
        const current = await read(file); const index = current.document.entries.findIndex(entry => entry.heading === heading); const created = index < 0;
        const entries = [...current.document.entries]; const entry = { heading, content };
        if (created) entries.push(entry); else entries[index] = entry;
        const nextUsage = await atomicWrite(file, { ...current.document, entries });
        return { created, file, heading, usage: nextUsage };
      });
    } }),
    define({ name: "memory_remove", description: "Remove one memory entry selected by its fixed file and heading. Owner only.", inputSchema: { type: "object", additionalProperties: false, required: ["file", "heading"], properties: { file: { type: "string", enum: Object.keys(MEMORY_FILES) }, heading: { type: "string", minLength: 1, maxLength: HEADING_CHARACTER_LIMIT } } }, policy: { capability: "memory.remove", tier: "privileged", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input) {
      return serialized(async () => {
        const file = selectedFile(input.file); const heading = selectedHeading(input.heading); const current = await read(file); const entries = current.document.entries.filter(entry => entry.heading !== heading);
        if (entries.length === current.document.entries.length) throw new Error(`${filename(file)} has no heading \"${heading}\"`);
        const nextUsage = await atomicWrite(file, { ...current.document, entries });
        return { removed: true, file, heading, usage: nextUsage };
      });
    } }),
  ];
  return {
    contributions: { tools },
    async start() {
      const workspace = await lstat(config.workspacePath);
      if (workspace.isSymbolicLink() || !workspace.isDirectory()) throw new Error(`memory workspace must be a regular directory: ${config.workspacePath}`);
      root = await realpath(config.workspacePath);
      memoryRoot = join(root, "memory");
      try {
        const stat = await lstat(memoryRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`memory directory must be a regular non-symlink directory: ${memoryRoot}`);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await mkdir(memoryRoot, { mode: 0o700 });
      }
      await chmod(memoryRoot, 0o700);
      for (const file of Object.keys(MEMORY_FILES) as MemoryFile[]) {
        try {
          const stat = await lstat(path(file));
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`memory file must be a regular non-symlink file: ${path(file)}`);
          parseDocument(file, await readFile(path(file), "utf8"));
        } catch (error) {
          if (!isMissing(error)) throw error;
          await writeFile(path(file), initialDocument(file), { mode: 0o600, flag: "wx" });
        }
        await chmod(path(file), 0o600);
      }
      await Promise.all((Object.keys(MEMORY_FILES) as MemoryFile[]).map(file => publish(file)));
    },
  };
}
