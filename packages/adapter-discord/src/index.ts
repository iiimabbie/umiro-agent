import type { InputEvent } from "@umiro/core/input";

export interface DiscordMessageEnvelope {
  readonly messageId: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly threadId?: string;
  readonly authorId: string;
  readonly authorName?: string;
  readonly content: string;
  readonly createdAt: string;
}

/** Converts Discord wire data into the Core's transport-neutral Input Event. */
export function toInputEvent(message: DiscordMessageEnvelope): InputEvent {
  return {
    id: `discord:${message.messageId}`,
    occurredAt: message.createdAt,
    identity: { transport: "discord", externalId: message.authorId, principalId: null },
    conversation: { transport: "discord", externalId: message.threadId ?? message.channelId, kind: message.threadId ? "thread" : (message.guildId ? "channel" : "direct") },
    content: [{ type: "text", text: message.content }],
    metadata: { messageId: message.messageId, channelId: message.channelId, ...(message.guildId ? { guildId: message.guildId } : {}) },
  };
}
