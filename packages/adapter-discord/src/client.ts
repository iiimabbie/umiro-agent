import { ActionRowBuilder, ActivityType, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, type ApplicationCommandDataResolvable, type ButtonInteraction, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { DiscordMessageEnvelope, DiscordTextTransport } from "./index.js";
import type { DiscordPresenceConfig } from "./trigger-policy.js";

export type DiscordApprovalAction = "approve" | "deny";
export interface DiscordApprovalPrompt { readonly approvalId: string; readonly operation: string; readonly details: string; readonly expiresAt: string }
export interface DiscordInteractionContext { readonly userId: string; readonly channelId: string; readonly guildId?: string }
export interface DiscordAdapterErrorContext { readonly event: "message" | "command" | "approval"; readonly channelId?: string; readonly messageId?: string }
export type DiscordAdapterErrorHandler = (error: unknown, context: DiscordAdapterErrorContext) => void;

export function approvalCustomId(action: DiscordApprovalAction, approvalId: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(approvalId)) throw new TypeError("invalid Discord approval ID");
  return `umiro:approval:${action}:${approvalId}`;
}

export function parseApprovalCustomId(value: string): { action: DiscordApprovalAction; approvalId: string } | undefined {
  const match = /^umiro:approval:(approve|deny):([A-Za-z0-9._-]{1,64})$/.exec(value);
  return match ? { action: match[1] as DiscordApprovalAction, approvalId: match[2]! } : undefined;
}

export class DiscordJsAdapter implements DiscordTextTransport {
  private readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [] });
  private listener?: (message: DiscordMessageEnvelope) => Promise<void>;
  private commands: readonly { name: string; description: string; ownerOnly?: boolean; ephemeral?: boolean; options?: readonly { name: string; description: string; type: "string" | "integer" | "boolean" | "channel"; required?: boolean; choices?: readonly { name: string; value: string | number }[] }[] }[] = [];
  private commandHandler?: (name: string, input: Record<string, string | number | boolean>, context: { userId: string; channelId: string; guildId?: string }) => Promise<Record<string, unknown>>;
  private approvalHandler?: (approvalId: string, action: DiscordApprovalAction, context: DiscordInteractionContext) => Promise<{ readonly content: string }>;
  private errorHandler?: DiscordAdapterErrorHandler;
  private readonly messageTimes = new Map<string, number[]>();
  private readonly channelQueues = new Map<string, Promise<void>>();

  onMessage(listener: (message: DiscordMessageEnvelope) => Promise<void>): void { this.listener = listener; }
  onCommand(commands: typeof this.commands, handler: NonNullable<typeof this.commandHandler>): void { this.commands = commands; this.commandHandler = handler; }
  onApproval(handler: NonNullable<typeof this.approvalHandler>): void { this.approvalHandler = handler; }
  onError(handler: DiscordAdapterErrorHandler): void { this.errorHandler = handler; }

  async start(token: string, presence?: DiscordPresenceConfig): Promise<void> {
    this.client.on("messageCreate", message => this.enqueueMessage(message));
    this.client.on("interactionCreate", interaction => {
      if (interaction.isChatInputCommand()) void this.handleCommand(interaction).catch(error => this.reportError(error, { event: "command", channelId: interaction.channelId }));
      else if (interaction.isButton()) void this.handleApproval(interaction).catch(error => this.reportError(error, { event: "approval", channelId: interaction.channelId }));
    });
    await this.client.login(token);
    if (!this.client.user) throw new Error("Discord login returned without a bot user");
    if (presence?.status || presence?.activity) this.client.user.setPresence({ status: presence.status ?? "online", activities: presence.activity ? [{ name: presence.activity, type: ActivityType.Playing }] : [] });
    console.log(`discord bot connected: ${this.client.user.tag} (${this.client.user.id})`);
    const types = { string: ApplicationCommandOptionType.String, integer: ApplicationCommandOptionType.Integer, boolean: ApplicationCommandOptionType.Boolean, channel: ApplicationCommandOptionType.Channel } as const;
    await this.client.application?.commands.set(this.commands.map(command => ({ name: command.name, description: command.description, options: command.options?.map(option => ({ type: types[option.type], name: option.name, description: option.description, required: option.required ?? false, ...(option.choices ? { choices: [...option.choices] } : {}) })) ?? [] })) as ApplicationCommandDataResolvable[]);
  }

  async stop(): Promise<void> { this.client.destroy(); }
  identity(): { readonly id: string; readonly tag: string } | undefined { return this.client.user ? { id: this.client.user.id, tag: this.client.user.tag } : undefined; }

  private enqueueMessage(message: Message): void {
    const previous = this.channelQueues.get(message.channelId) ?? Promise.resolve();
    const current = previous.then(() => this.handle(message)).catch(error => this.reportError(error, { event: "message", channelId: message.channelId, messageId: message.id }));
    this.channelQueues.set(message.channelId, current);
    void current.finally(() => { if (this.channelQueues.get(message.channelId) === current) this.channelQueues.delete(message.channelId); });
  }

  private reportError(error: unknown, context: DiscordAdapterErrorContext): void {
    try { this.errorHandler?.(error, context); } catch { /* Observability must not alter adapter behavior. */ }
  }

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

  async sendFiles(channelId: string, files: readonly { readonly path: string; readonly name?: string }[]): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Discord channel is not sendable: ${channelId}`);
    const sent = await channel.send({ files: files.map(file => ({ attachment: file.path, ...(file.name ? { name: file.name } : {}) })) });
    return { messageId: sent.id };
  }

  async sendApproval(channelId: string, prompt: DiscordApprovalPrompt): Promise<{ messageId: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Discord channel is not sendable: ${channelId}`);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(approvalCustomId("approve", prompt.approvalId)).setLabel("Approve").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(approvalCustomId("deny", prompt.approvalId)).setLabel("Deny").setStyle(ButtonStyle.Secondary),
    );
    const content = `Approval required: **${prompt.operation.slice(0, 120)}**\nExpires: ${prompt.expiresAt}\n\n${prompt.details}`.slice(0, 1900);
    const sent = await channel.send({ content, components: [row] });
    return { messageId: sent.id };
  }

  async editText(channelId: string, messageId: string, text: string): Promise<{ messageId: string; migrated: boolean }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel messages are unavailable: ${channelId}`);
    const message = await channel.messages.fetch(messageId);
    const edited = await message.edit({ content: text });
    return { messageId: edited.id, migrated: false };
  }

  private async handle(message: Message): Promise<void> {
    if (!this.listener) return;
    if (message.author.id === this.client.user?.id) return;
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
      authorBot: message.author.bot,
      botMentioned: this.client.user ? message.mentions.users.has(this.client.user.id) : false,
      replyToBot: this.client.user ? replyAuthorId === this.client.user.id : false,
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

  private async handleApproval(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseApprovalCustomId(interaction.customId);
    if (!parsed || !this.approvalHandler) return;
    await interaction.deferUpdate();
    try {
      const result = await this.approvalHandler(parsed.approvalId, parsed.action, { userId: interaction.user.id, channelId: interaction.channelId, ...(interaction.guildId ? { guildId: interaction.guildId } : {}) });
      await interaction.editReply({ content: result.content.slice(0, 1900), components: [] });
    } catch {
      await interaction.followUp({ content: "Approval failed or is no longer actionable.", ephemeral: true });
    }
  }
}
