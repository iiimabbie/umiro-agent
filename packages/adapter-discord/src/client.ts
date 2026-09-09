import { Client, GatewayIntentBits, type ApplicationCommandDataResolvable, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { DiscordMessageEnvelope, DiscordTextTransport } from "./index.js";

export class DiscordJsAdapter implements DiscordTextTransport {
  private readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [] });
  private listener?: (message: DiscordMessageEnvelope) => Promise<void>;
  private commands: readonly { name: string; description: string; ownerOnly?: boolean }[] = [];
  private commandHandler?: (name: string, input: Record<string, string>, userId: string) => Promise<Record<string, unknown>>;

  onMessage(listener: (message: DiscordMessageEnvelope) => Promise<void>): void { this.listener = listener; }
  onCommand(commands: readonly { name: string; description: string; ownerOnly?: boolean }[], handler: (name: string, input: Record<string, string>, userId: string) => Promise<Record<string, unknown>>): void { this.commands = commands; this.commandHandler = handler; }

  async start(token: string): Promise<void> {
    this.client.on("messageCreate", message => void this.handle(message));
    this.client.on("interactionCreate", interaction => { if (interaction.isChatInputCommand()) void this.handleCommand(interaction); });
    await this.client.login(token);
    await this.client.application?.commands.set(this.commands.map(command => ({ name: command.name, description: command.description, options: [{ type: 3, name: "input", description: "JSON input", required: false }] })) as ApplicationCommandDataResolvable[]);
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

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.commandHandler) return;
    await interaction.deferReply({ ephemeral: true });
    try {
      const raw = interaction.options.getString("input") ?? "{}";
      const input = JSON.parse(raw) as Record<string, string>;
      const result = await this.commandHandler(interaction.commandName, input, interaction.user.id);
      await interaction.editReply({ content: JSON.stringify(result).slice(0, 1900) });
    } catch (error) { await interaction.editReply({ content: `Command failed: ${error instanceof Error ? error.message : String(error)}` }); }
  }
}
