import { ApplicationCommandOptionType, Client, GatewayIntentBits, type ApplicationCommandDataResolvable, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { DiscordMessageEnvelope, DiscordTextTransport } from "./index.js";

export class DiscordJsAdapter implements DiscordTextTransport {
  private readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [] });
  private listener?: (message: DiscordMessageEnvelope) => Promise<void>;
  private commands: readonly { name: string; description: string; ownerOnly?: boolean; ephemeral?: boolean; options?: readonly { name: string; description: string; type: "string" | "integer" | "boolean" | "channel"; required?: boolean; choices?: readonly { name: string; value: string | number }[] }[] }[] = [];
  private commandHandler?: (name: string, input: Record<string, string | number | boolean>, context: { userId: string; channelId: string; guildId?: string }) => Promise<Record<string, unknown>>;
  private readonly messageTimes = new Map<string, number[]>();

  onMessage(listener: (message: DiscordMessageEnvelope) => Promise<void>): void { this.listener = listener; }
  onCommand(commands: typeof this.commands, handler: NonNullable<typeof this.commandHandler>): void { this.commands = commands; this.commandHandler = handler; }

  async start(token: string): Promise<void> {
    this.client.on("messageCreate", message => void this.handle(message));
    this.client.on("interactionCreate", interaction => { if (interaction.isChatInputCommand()) void this.handleCommand(interaction); });
    await this.client.login(token);
    if (!this.client.user) throw new Error("Discord login returned without a bot user");
    console.log(`discord bot connected: ${this.client.user.tag} (${this.client.user.id})`);
    const types = { string: ApplicationCommandOptionType.String, integer: ApplicationCommandOptionType.Integer, boolean: ApplicationCommandOptionType.Boolean, channel: ApplicationCommandOptionType.Channel } as const;
    await this.client.application?.commands.set(this.commands.map(command => ({ name: command.name, description: command.description, options: command.options?.map(option => ({ type: types[option.type], name: option.name, description: option.description, required: option.required ?? false, ...(option.choices ? { choices: [...option.choices] } : {}) })) ?? [] })) as ApplicationCommandDataResolvable[]);
  }

  async stop(): Promise<void> { this.client.destroy(); }

  async sendText(channelId: string, text: string): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Discord channel is not sendable: ${channelId}`);
    const sent = await channel.send({ content: text });
    return { messageId: sent.id };
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("sendTyping" in channel)) return;
    await channel.sendTyping();
  }

  async editText(channelId: string, messageId: string, text: string): Promise<{ messageId: string; migrated: boolean }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel messages are unavailable: ${channelId}`);
    const message = await channel.messages.fetch(messageId);
    const edited = await message.edit({ content: text });
    return { messageId: edited.id, migrated: false };
  }

  private async handle(message: Message): Promise<void> {
    if (message.author.bot || !this.listener) return;
    const now = Date.now();
    const recent = (this.messageTimes.get(message.author.id) ?? []).filter(timestamp => now - timestamp < 60_000);
    if (recent.length >= 30) return;
    recent.push(now);
    this.messageTimes.set(message.author.id, recent);
    let replyAuthorId: string | undefined;
    if (message.reference?.messageId) {
      try { replyAuthorId = (await message.fetchReference()).author.id; } catch { /* deleted or inaccessible reference */ }
    }
    await this.listener({
      messageId: message.id,
      channelId: message.channelId,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      ...(message.channel.isThread() ? { threadId: message.channel.id } : {}),
      authorId: message.author.id,
      authorName: message.author.globalName ?? message.author.username,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      mentionedUserIds: [...message.mentions.users.keys()],
      ...(message.reference?.messageId ? { replyToMessageId: message.reference.messageId } : {}),
      ...(replyAuthorId ? { replyAuthorId } : {}),
      attachments: [...message.attachments.values()].map(attachment => ({ id: attachment.id, url: attachment.url, filename: attachment.name, size: attachment.size, ...(attachment.contentType ? { mediaType: attachment.contentType } : {}) })),
    });
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.commandHandler) return;
    const definition = this.commands.find(command => command.name === interaction.commandName);
    await interaction.deferReply({ ephemeral: definition?.ephemeral ?? true });
    try {
      const input = Object.fromEntries(interaction.options.data.flatMap(option => option.value === undefined ? [] : [[option.name, option.value]])) as Record<string, string | number | boolean>;
      const result = await this.commandHandler(interaction.commandName, input, { userId: interaction.user.id, channelId: interaction.channelId, ...(interaction.guildId ? { guildId: interaction.guildId } : {}) });
      await interaction.editReply({ content: JSON.stringify(result).slice(0, 1900) });
    } catch (error) { await interaction.editReply({ content: `Command failed: ${error instanceof Error ? error.message : String(error)}` }); }
  }
}
