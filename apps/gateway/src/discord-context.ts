import type { ContextProvider } from "@umiro/core";

function string(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

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
    const content = {
      transport: "discord",
      currentChannel: { id: channelId, kind: threadId ? "thread" : request.inputEvent.conversation.kind },
      ...(string(metadata?.guildId) ? { guild: { id: string(metadata?.guildId)! } } : {}),
      ...(threadId ? { thread: {
        id: threadId,
        ...(string(metadata?.threadParentId) ? { parent: { id: string(metadata?.threadParentId)!, kind: string(metadata?.threadParentKind) ?? "channel", ...(string(metadata?.threadParentName) ? { name: string(metadata?.threadParentName)! } : {}) } } : {}),
      } } : {}),
    };
    return [{ id: `discord.runtime:${request.runId}`, providerId: "discord.runtime", role: "transport-context", content: JSON.stringify(content), source: { kind: "discord-adapter", ref: request.inputEvent.id }, influence: "information", instructionAuthority: "none", retention: "essential" }];
  },
};
