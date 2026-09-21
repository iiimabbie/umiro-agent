import type { ContextProvider } from "@umiro/core";

function string(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

export function createCurrentTimeContextProvider(now: () => Date = () => new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): ContextProvider {
  return {
    id: "runtime.current-time",
    role: "runtime-context",
    priority: 4,
    async load(request) {
      const instant = now();
      const local = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "full", timeStyle: "long", hour12: false }).format(instant);
      return [{ id: `runtime.current-time:${request.runId}`, providerId: "runtime.current-time", role: "runtime-context", content: `Current datetime: ${instant.toISOString()} (${timeZone}: ${local})`, source: { kind: "host-clock", ref: timeZone }, influence: "information", instructionAuthority: "none", retention: "essential" }];
    },
  };
}

export const runtimeModelContextProvider: ContextProvider = {
  id: "runtime.model",
  role: "runtime-context",
  priority: 4,
  async load(request) {
    const profile = request.execution.modelProfile;
    if (!profile) return [];
    return [{
      id: `runtime.model:${request.runId}`,
      providerId: "runtime.model",
      role: "runtime-context",
      content: JSON.stringify({ activeModel: { id: profile.model, profile: profile.id, protocol: profile.protocol, reasoningEffort: profile.reasoningEffort ?? "default" } }),
      source: { kind: "host-runtime", ref: request.runId },
      influence: "information",
      instructionAuthority: "none",
      retention: "essential",
    }];
  },
};

/** Trusted adapter metadata for destination-sensitive Discord tools. Message
 * text remains untrusted and cannot override these transport facts. */
export const discordRuntimeContextProvider: ContextProvider = {
  id: "discord.runtime",
  role: "transport-context",
  priority: 5,
  async load(request) {
    if (request.inputEvent?.identity.transport !== "discord") return [];
    const metadata = request.inputEvent.metadata;
    const channelId = string(metadata?.channelId);
    if (!channelId) return [];
    const threadId = string(metadata?.threadId);
    const parentId = string(metadata?.threadParentId);
    const parentKind = string(metadata?.threadParentKind);
    const authorBot = typeof metadata?.authorBot === "boolean" ? metadata.authorBot : undefined;
    const content = {
      transport: "discord",
      ...(authorBot !== undefined ? { authorBot } : {}),
      currentChannel: { id: channelId, kind: threadId ? "thread" : request.inputEvent.conversation.kind },
      ...(string(metadata?.guildId) ? { guild: { id: string(metadata?.guildId)! } } : {}),
      ...(threadId ? { currentPost: { id: threadId } } : {}),
      ...(threadId && parentId && (parentKind === "forum" || parentKind === undefined)
        ? { currentForum: { id: parentId, ...(string(metadata?.threadParentName) ? { name: string(metadata?.threadParentName)! } : {}) } }
        : {}),
      ...(threadId ? { thread: {
        id: threadId,
        ...(parentId ? { parent: { id: parentId, kind: parentKind ?? "channel", ...(string(metadata?.threadParentName) ? { name: string(metadata?.threadParentName)! } : {}) } } : {}),
      } } : {}),
    };
    return [{ id: `discord.runtime:${request.runId}`, providerId: "discord.runtime", role: "transport-context", content: JSON.stringify(content), source: { kind: "discord-adapter", ref: request.inputEvent.id }, influence: "information", instructionAuthority: "none", retention: "essential" }];
  },
};

/** A Discord Run exists only after the pre-Run reply gate accepted the turn. */
export const discordOutputPolicyProvider: ContextProvider = {
  id: "discord.output-policy",
  role: "runtime-policy",
  priority: 6,
  async load(request) {
    if (request.inputEvent?.identity.transport !== "discord") return [];
    return [{
      id: `discord.output-policy:${request.runId}`,
      providerId: "discord.output-policy",
      role: "runtime-policy",
      content: "This Discord turn has already passed the reply gate. Return a non-empty final text response, including after using reaction or other tools.",
      source: { kind: "host-policy", ref: "discord-output" },
      influence: "instruction",
      instructionAuthority: "scoped",
      retention: "essential",
    }];
  },
};

export function createDiscordApplicationEmojiContextProvider(catalog: () => readonly { readonly name: string }[]): ContextProvider {
  return {
    id: "discord.application-emojis",
    role: "transport-context",
    priority: 7,
    async load(request) {
      if (request.inputEvent?.identity.transport !== "discord") return [];
      const names = catalog().map(emoji => emoji.name).filter(name => /^[A-Za-z0-9_]{2,32}$/.test(name)).sort().map(name => `:${name}:`);
      if (names.length === 0) return [];
      return [{
        id: `discord.application-emojis:${request.runId}`,
        providerId: "discord.application-emojis",
        role: "transport-context",
        content: `Available Discord application emoji: ${names.join(" ")}. Use an emoji by writing its exact :name: form; unknown names remain plain text.`,
        source: { kind: "discord-adapter", ref: "application-emojis" },
        influence: "information",
        instructionAuthority: "none",
        retention: "normal",
      }];
    },
  };
}
