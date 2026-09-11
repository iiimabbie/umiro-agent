import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "@umiro/core/ports";
import type { ContextProvider, ContextRole } from "@umiro/core/context";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { ToolDefinition, ToolExecutionResult } from "@umiro/core/tool";

interface ContextFilesConfig {
  readonly workspacePath: string;
}

const FILES: Readonly<Record<"soul" | "agent" | "owner" | "memory" | "bootstrap", string>> = {
  soul: "SOUL.md",
  agent: "AGENT.md",
  owner: "OWNER.md",
  memory: "MEMORY.md",
  bootstrap: "BOOTSTRAP.md",
};

const PRIORITY: Readonly<Record<"soul" | "agent" | "owner" | "memory", number>> = {
  soul: 100,
  agent: 200,
  owner: 250,
  memory: 300,
};

const SOUL_TEMPLATE = `# SOUL\n\nWho you are. This file is the only source of your identity and voice — your name, how you speak,\nwhat you care about, and where your boundaries lie. Nothing here describes what you do; that is\n\`AGENT.md\`.\n\n## Name\n\n<!-- What you are called, and how you refer to yourself. -->\n\n## Voice\n\n<!-- Register, warmth, humour, verbosity, emoji habits. Write it as description, not as rules. -->\n\n## Values\n\n<!-- What you care about and what you refuse, in your own terms. -->\n\n## Boundaries\n\n<!-- Where you decline, deflect, or change the subject — as a matter of character rather than policy. -->\n`;
const OWNER_TEMPLATE = `# OWNER\n\nThe person this agent serves. Read on every turn, so keep it short and current.\n\n## Identity\n\n- Name:\n- How to address them:\n- Pronouns:\n- Timezone:\n- Languages:\n\n## Standing directives\n\n<!-- Imperative statements, one per line, each prefixed with the date it took effect.\n     Example:\n     - (2026-01-15) Give the conclusion first, then the reasoning.\n     - (2026-01-15) Ask before anything destructive or irreversible.\n     Remove this comment once filled. -->\n\n## Notes\n\n<!-- Anything else that stays true across conversations and is not a directive. -->\n`;

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

function bootstrapProvider(config: ContextFilesConfig, getRoot: () => string): ContextProvider {
  return {
    id: "context.bootstrap",
    role: "bootstrap",
    priority: 50,
    async load(request) {
      if (!request.execution.actor.roles.includes("owner")) return [];
      const path = join(getRoot(), FILES.bootstrap);
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`context source must be a regular non-symlink file: ${path}`);
        const content = await readFile(path, "utf8");
        if (!content.trim()) return [];
        return [{ id: "context.bootstrap:file", providerId: "context.bootstrap", role: "bootstrap", content, source: { kind: "file", ref: path }, influence: "instruction", instructionAuthority: "scoped", retention: "essential" }];
      } catch (error) { if (isMissing(error)) return []; throw error; }
    },
  };
}

export function createPlugin(context: PluginSetupContext): PluginInstance {
  const config = context.config as unknown as ContextFilesConfig;
  let workspaceRoot = ""; let writeQueue = Promise.resolve();
  const ownerPath = () => join(workspaceRoot, "OWNER.md");
  const bootstrapPath = () => join(workspaceRoot, FILES.bootstrap);
  const removeBootstrapIfConfigured = async (): Promise<void> => {
    try {
      const [soul, owner] = await Promise.all([readFile(join(workspaceRoot, FILES.soul), "utf8"), readFile(ownerPath(), "utf8")]);
      if (soul === SOUL_TEMPLATE || owner === OWNER_TEMPLATE) return;
      await unlink(bootstrapPath());
      context.logger?.info("bootstrap.removed", "Removed completed bootstrap workspace protocol");
    } catch (error) {
      if (isMissing(error)) return;
      context.logger?.warn("bootstrap.cleanup_failed", "Bootstrap cleanup failed; setup will remain active", { error: error instanceof Error ? error.name : "unknown" });
    }
  };
  const publish = async (role: keyof typeof FILES): Promise<void> => {
    const search = context.services?.searchDocuments; if (!search) return;
    const path = join(workspaceRoot, FILES[role]);
    try {
      const content = await readFile(path, "utf8");
      await search.replaceSource(FILES[role], [{ id: FILES[role], sourceType: "workspace_file", sourceId: FILES[role], text: content, visibility: { kind: "all" } }]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await search.removeSource(FILES[role]);
      else throw error;
    }
  };
  const ownerWrite = async (content: string) => { const normalized = `${content.trim()}\n`; if (normalized.length > 20_000) throw new Error("OWNER.md exceeds 20000 characters"); const temporary = `${ownerPath()}.${process.pid}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, normalized, { mode: 0o600 }); await rename(temporary, ownerPath()); await publish("owner"); };
  const serial = async <T>(operation: () => Promise<T>): Promise<T> => { const previous = writeQueue; let release!: () => void; writeQueue = new Promise<void>(resolve => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } };
  const result = (output: unknown): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus: "confirmed" });
  const failure = (error: unknown): ToolExecutionResult => ({ ok: false, effectStatus: "not_applicable", error: { code: "owner_profile_error", message: error instanceof Error ? error.message : String(error), retryable: false } });
  const tool = (name: string, description: string, inputSchema: JsonObject, execute: (input: JsonObject) => Promise<unknown>): ToolDefinition => ({ name, description, inputSchema, policy: { capability: "owner.profile.write", tier: "privileged", interactionRequirement: "not_required", sideEffect: "idempotent" }, async execute(input) { try { return result(await execute(input)); } catch (error) { return failure(error); } } });
  const tools = [
    tool("owner_profile_add", "Append one durable fact to OWNER.md. Owner only.", { type: "object", additionalProperties: false, required: ["content"], properties: { content: { type: "string", minLength: 1 } } }, async input => serial(async () => { const current = await readFile(ownerPath(), "utf8").catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? "# OWNER\n" : Promise.reject(error)); const content = String(input.content).trim(); if (current.includes(content)) return { added: false }; await ownerWrite(`${current.trim()}\n\n${content}`); return { added: true }; })),
    tool("owner_profile_replace", "Replace one exact occurrence in OWNER.md. Owner only.", { type: "object", additionalProperties: false, required: ["oldText", "newText"], properties: { oldText: { type: "string", minLength: 1 }, newText: { type: "string" } } }, async input => serial(async () => { const current = await readFile(ownerPath(), "utf8"); const oldText = String(input.oldText); if (current.split(oldText).length !== 2) throw new Error("oldText must match exactly once"); await ownerWrite(current.replace(oldText, String(input.newText))); return { replaced: true }; })),
  ];
  const history: ContextProvider = { id: "context.conversation_history", role: "conversation-history", priority: 700, async load(request) {
    const blocks = [];
    const compacted = request.conversationCompaction;
    if (compacted) blocks.push({ id: "context.conversation_history:compacted", providerId: "context.conversation_history", role: "conversation-history", content: `<conversation-history-compaction through-sequence="${compacted.throughSequence}" trust="untrusted-data">\n${compacted.summary}\n</conversation-history-compaction>`, source: { kind: "conversation-compaction", ref: compacted.conversationId, metadata: { throughSequence: compacted.throughSequence, sourceHash: compacted.sourceHash } }, influence: "information" as const, instructionAuthority: "none" as const, parentSourceRef: compacted.sourceHash });
    const items = request.recentHistory ?? [];
    if (items.length) { const lines = items.flatMap(item => { const user = item.turn.content.filter(block => block.type === "text").map(block => block.text).join("\n"); return [`User (${item.turn.actorPrincipalId}): ${user}`, ...(item.assistantText ? [`Assistant: ${item.assistantText}`] : [])]; }); blocks.push({ id: "context.conversation_history:recent", providerId: "context.conversation_history", role: "conversation-history", content: `<conversation-history>\n${lines.join("\n")}\n</conversation-history>`, source: { kind: "conversation", ref: items[0]!.turn.conversationId }, influence: "information" as const, instructionAuthority: "none" as const }); }
    const reply = request.replyTarget;
    if (reply) { const user = reply.turn.content.filter(block => block.type === "text").map(block => block.text).join("\n"); blocks.push({ id: "context.conversation_history:reply-target", providerId: "context.conversation_history", role: "conversation-history", content: `<discord-reply-target trust="untrusted-data" turn-id="${reply.turn.id}">\n${user}${reply.assistantText ? `\nAssistant reply: ${reply.assistantText}` : ""}\n</discord-reply-target>`, source: { kind: "conversation-turn", ref: reply.turn.id }, influence: "information" as const, instructionAuthority: "none" as const }); }
    else {
      const metadata = request.inputEvent?.metadata;
      const referenceId = typeof metadata?.replyToMessageId === "string" ? metadata.replyToMessageId : undefined;
      if (referenceId) {
        const author = typeof metadata?.replyAuthorId === "string" ? metadata.replyAuthorId : "unknown";
        const content = typeof metadata?.replyToContent === "string" ? metadata.replyToContent : "[內容無法取得；僅保留 Discord 訊息參照。]";
        blocks.push({ id: "context.conversation_history:reply-reference", providerId: "context.conversation_history", role: "conversation-history", content: `<discord-reply-target trust="untrusted-data" external-message-id="${referenceId}" author-id="${author}">\n${content}\n</discord-reply-target>`, source: { kind: "discord-message", ref: referenceId }, influence: "information" as const, instructionAuthority: "none" as const });
      }
    }
    return blocks;
  } };
  return {
    contributions: {
      contextProviders: [
        bootstrapProvider(config, () => workspaceRoot),
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
      await removeBootstrapIfConfigured();
      await Promise.all((Object.keys(FILES) as Array<keyof typeof FILES>).map(role => publish(role)));
    },
  };
}
