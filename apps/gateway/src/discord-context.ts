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
    const content = {
      transport: "discord",
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

/** Host-owned Discord response contract. Tool calls such as discord_react may
 * still be used before selecting the no-text outcome. */
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
      content: "Choose the appropriate Discord interaction: reply with text, use a reaction tool and then reply with text, use only a reaction tool, or do nothing. When no text should be sent, your final response must be exactly NO_REPLY.",
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
