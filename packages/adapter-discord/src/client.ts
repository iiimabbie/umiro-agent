import { Client, GatewayIntentBits, type Message } from "discord.js";
import type { DiscordMessageEnvelope, DiscordTextTransport } from "./index.js";

export class DiscordJsAdapter implements DiscordTextTransport {
  private readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [] });
  private listener?: (message: DiscordMessageEnvelope) => Promise<void>;

  onMessage(listener: (message: DiscordMessageEnvelope) => Promise<void>): void { this.listener = listener; }

  async start(token: string): Promise<void> {
    this.client.on("messageCreate", message => void this.handle(message));
    await this.client.login(token);
  }

  async stop(): Promise<void> { this.client.destroy(); }

  async sendText(channelId: string, text: string): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Discord channel is not sendable: ${channelId}`);
    const sent = await channel.send({ content: text });
    return { messageId: sent.id };
  }

  private async handle(message: Message): Promise<void> {
    if (message.author.bot || !this.listener) return;
    await this.listener({
      messageId: message.id,
      channelId: message.channelId,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      ...(message.channel.isThread() ? { threadId: message.channel.id } : {}),
      authorId: message.author.id,
      authorName: message.author.globalName ?? message.author.username,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    });
  }
}
