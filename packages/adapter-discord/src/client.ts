import { ActionRowBuilder, ActivityType, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, type ApplicationCommandDataResolvable, type ButtonInteraction, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { DiscordMessageEnvelope, DiscordTextTransport } from "./index.js";
import type { DiscordPluginService } from "@umiro/core/plugin";
import type { DiscordPresenceConfig } from "./trigger-policy.js";

type DiscordCommandDefinition = { name: string; description: string; ownerOnly?: boolean; ephemeral?: boolean; options?: readonly { name: string; description: string; type: "string" | "integer" | "boolean" | "channel"; required?: boolean; choices?: readonly { name: string; value: string | number }[] }[] };
type DiscordCommandManager = { set(commands: readonly ApplicationCommandDataResolvable[]): Promise<unknown> };

export function applicationCommandData(commands: readonly DiscordCommandDefinition[]): readonly ApplicationCommandDataResolvable[] {
  const types = { string: ApplicationCommandOptionType.String, integer: ApplicationCommandOptionType.Integer, boolean: ApplicationCommandOptionType.Boolean, channel: ApplicationCommandOptionType.Channel } as const;
  return commands.map(command => ({
    name: command.name,
    description: command.description,
    options: command.options?.map(option => ({ type: types[option.type], name: option.name, description: option.description, required: option.required ?? false, ...(option.choices ? { choices: [...option.choices] } : {}) })) ?? [],
  })) as ApplicationCommandDataResolvable[];
}

/** Bulk overwrite both scopes so commands left behind by an older release cannot
 * remain visible in a guild after this adapter becomes authoritative. */
export async function syncApplicationCommands(application: DiscordCommandManager, guilds: readonly DiscordCommandManager[], commands: readonly ApplicationCommandDataResolvable[]): Promise<void> {
  await application.set(commands);
  await Promise.all(guilds.map(guild => guild.set(commands)));
}

export type DiscordApprovalAction = "approve" | "deny";
export interface DiscordApprovalPrompt { readonly approvalId: string; readonly operation: string; readonly details: string; readonly expiresAt: string }
export interface DiscordInteractionContext { readonly userId: string; readonly channelId: string; readonly guildId?: string }
export interface DiscordButtonInteraction extends DiscordInteractionContext { readonly buttonSetId: string; readonly buttonId: string }
export interface DiscordAdapterErrorContext { readonly event: "message" | "command" | "approval" | "button"; readonly channelId?: string; readonly messageId?: string }
export type DiscordAdapterErrorHandler = (error: unknown, context: DiscordAdapterErrorContext) => void;

export function approvalCustomId(action: DiscordApprovalAction, approvalId: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(approvalId)) throw new TypeError("invalid Discord approval ID");
  return `umiro:approval:${action}:${approvalId}`;
}

export function parseApprovalCustomId(value: string): { action: DiscordApprovalAction; approvalId: string } | undefined {
  const match = /^umiro:approval:(approve|deny):([A-Za-z0-9._-]{1,64})$/.exec(value);
  return match ? { action: match[1] as DiscordApprovalAction, approvalId: match[2]! } : undefined;
}
export function parseButtonCustomId(value: string): { buttonSetId: string; buttonId: string } | undefined {
  const match = /^umiro:button:([A-Za-z0-9-]{1,64}):([A-Za-z0-9_-]{1,32})$/.exec(value);
  return match ? { buttonSetId: match[1]!, buttonId: match[2]! } : undefined;
}

export class DiscordJsAdapter implements DiscordTextTransport, DiscordPluginService {
  private readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [] });
  private listener?: (message: DiscordMessageEnvelope) => Promise<void>;
  private steerHandler?: (message: DiscordMessageEnvelope) => Promise<boolean>;
  private commands: readonly DiscordCommandDefinition[] = [];
  private commandHandler?: (name: string, input: Record<string, string | number | boolean>, context: { userId: string; channelId: string; guildId?: string }) => Promise<Record<string, unknown>>;
  private approvalHandler?: (approvalId: string, action: DiscordApprovalAction, context: DiscordInteractionContext) => Promise<{ readonly content: string }>;
  private buttonHandler?: (interaction: DiscordButtonInteraction) => Promise<{ readonly content: string }>;
  private errorHandler?: DiscordAdapterErrorHandler;
  private readonly messageTimes = new Map<string, number[]>();
  private readonly channelQueues = new Map<string, Promise<void>>();
  private respondToBots = true;

  onMessage(listener: (message: DiscordMessageEnvelope) => Promise<void>): void { this.listener = listener; }
  /** Called before the per-channel session queue. Returning true means the
   * event was durably accepted by the active Run. */
  onSteer(handler: (message: DiscordMessageEnvelope) => Promise<boolean>): void { this.steerHandler = handler; }
  onCommand(commands: typeof this.commands, handler: NonNullable<typeof this.commandHandler>): void { this.commands = commands; this.commandHandler = handler; }
  onApproval(handler: NonNullable<typeof this.approvalHandler>): void { this.approvalHandler = handler; }
  onButton(handler: NonNullable<typeof this.buttonHandler>): void { this.buttonHandler = handler; }
  onError(handler: DiscordAdapterErrorHandler): void { this.errorHandler = handler; }

  async start(token: string, presence?: DiscordPresenceConfig): Promise<void> {
    this.client.on("messageCreate", message => this.enqueueMessage(message));
    this.client.on("interactionCreate", interaction => {
      if (interaction.isChatInputCommand()) void this.handleCommand(interaction).catch(error => this.reportError(error, { event: "command", channelId: interaction.channelId }));
      else if (interaction.isButton()) {
        const event = parseApprovalCustomId(interaction.customId) ? "approval" : "button";
        void this.handleButton(interaction).catch(error => this.reportError(error, { event, channelId: interaction.channelId }));
      }
    });
    await this.client.login(token);
    if (!this.client.user) throw new Error("Discord login returned without a bot user");
    if (presence?.status || presence?.activity) this.client.user.setPresence({ status: presence.status ?? "online", activities: presence.activity ? [{ name: presence.activity, type: ActivityType.Playing }] : [] });
    console.log(`discord bot connected: ${this.client.user.tag} (${this.client.user.id})`);
    if (!this.client.application) throw new Error("Discord login returned without an application");
    await syncApplicationCommands(this.client.application.commands, [...this.client.guilds.cache.values()].map(guild => guild.commands), applicationCommandData(this.commands));
  }

  async stop(): Promise<void> { this.client.destroy(); }
  identity(): { readonly id: string; readonly tag: string } | undefined { return this.client.user ? { id: this.client.user.id, tag: this.client.user.tag } : undefined; }

  private enqueueMessage(message: Message): void {
    void this.normalize(message).then(async envelope => {
      if (!envelope) return;
      if (this.steerHandler && await this.steerHandler(envelope)) return;
      const previous = this.channelQueues.get(message.channelId) ?? Promise.resolve();
      const current = previous.then(() => this.listener?.(envelope)).catch(error => this.reportError(error, { event: "message", channelId: message.channelId, messageId: message.id }));
      this.channelQueues.set(message.channelId, current);
      void current.finally(() => { if (this.channelQueues.get(message.channelId) === current) this.channelQueues.delete(message.channelId); });
    }).catch(error => this.reportError(error, { event: "message", channelId: message.channelId, messageId: message.id }));
  }

  private reportError(error: unknown, context: DiscordAdapterErrorContext): void {
    try { this.errorHandler?.(error, context); } catch { /* Observability must not alter adapter behavior. */ }
  }

  async sendText(channelId: string, text: string, signal?: AbortSignal): Promise<{ messageId: string }> {
    if (signal?.aborted) throw signal.reason;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Discord channel is not sendable: ${channelId}`);
    if (signal?.aborted) throw signal.reason;
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

  async sendMessage(input: { readonly channelId: string; readonly content: string; readonly signal?: AbortSignal }): Promise<{ readonly messageId: string }> {
    if (input.signal?.aborted) throw input.signal.reason;
    return this.sendText(input.channelId, input.content, input.signal);
  }

  async sendButtons(input: { readonly buttonSetId: string; readonly channelId: string; readonly content: string; readonly buttons: readonly { readonly id: string; readonly label: string; readonly style: "primary" | "secondary" | "success" | "danger" }[]; readonly signal?: AbortSignal }): Promise<{ readonly messageId: string }> {
    if (input.signal?.aborted) throw input.signal.reason;
    if (input.buttons.length < 1 || input.buttons.length > 25) throw new TypeError("Discord button set must contain 1 to 25 buttons");
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Discord channel is not sendable: ${input.channelId}`);
    const styles = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger } as const;
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let index = 0; index < input.buttons.length; index += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const button of input.buttons.slice(index, index + 5)) row.addComponents(new ButtonBuilder().setCustomId(`umiro:button:${input.buttonSetId}:${button.id}`).setLabel(button.label.slice(0, 80)).setStyle(styles[button.style]));
      rows.push(row);
    }
    if (input.signal?.aborted) throw input.signal.reason;
    const sent = await channel.send({ content: input.content.slice(0, 2_000), components: rows });
    return { messageId: sent.id };
  }

  async react(input: { readonly channelId: string; readonly messageId: string; readonly emoji: string; readonly signal?: AbortSignal }): Promise<void> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel messages are unavailable: ${input.channelId}`);
    const message = await channel.messages.fetch(input.messageId);
    if (input.signal?.aborted) throw input.signal.reason;
    await message.react(input.emoji);
  }

  async pin(input: { readonly channelId: string; readonly messageId: string; readonly signal?: AbortSignal }): Promise<void> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel messages are unavailable: ${input.channelId}`);
    const message = await channel.messages.fetch(input.messageId);
    if (input.signal?.aborted) throw input.signal.reason;
    await message.pin();
  }

  async unpin(input: { readonly channelId: string; readonly messageId: string; readonly signal?: AbortSignal }): Promise<void> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel messages are unavailable: ${input.channelId}`);
    const message = await channel.messages.fetch(input.messageId);
    if (input.signal?.aborted) throw input.signal.reason;
    await message.unpin();
  }

  async fetchMessage(input: { readonly channelId: string; readonly messageId: string; readonly signal?: AbortSignal }): Promise<{ readonly messageId: string; readonly channelId: string; readonly authorId: string; readonly content: string; readonly createdAt: string }> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel messages are unavailable: ${input.channelId}`);
    const message = await channel.messages.fetch(input.messageId);
    if (input.signal?.aborted) throw input.signal.reason;
    return { messageId: message.id, channelId: message.channelId, authorId: message.author.id, content: message.content, createdAt: message.createdAt.toISOString() };
  }

  async fetchThreadStarter(input: { readonly threadId: string; readonly signal?: AbortSignal }): Promise<{ readonly messageId: string; readonly channelId: string; readonly authorId: string; readonly authorName: string; readonly content: string; readonly threadName: string; readonly createdAt: string } | undefined> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.threadId);
    if (!channel?.isThread() || !("messages" in channel)) return undefined;
    const message = await channel.messages.fetch(input.threadId);
    if (input.signal?.aborted) throw input.signal.reason;
    return { messageId: message.id, channelId: message.channelId, authorId: message.author.id, authorName: message.author.displayName, content: message.content, threadName: channel.name, createdAt: message.createdAt.toISOString() };
  }

  async createThread(input: { readonly channelId: string; readonly name: string; readonly messageId?: string; readonly signal?: AbortSignal }): Promise<{ readonly threadId: string }> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel?.isTextBased() || !("threads" in channel)) throw new Error(`Discord channel cannot create threads: ${input.channelId}`);
    const thread = await channel.threads.create({ name: input.name.slice(0, 100), ...(input.messageId ? { startMessage: input.messageId } : {}) });
    return { threadId: thread.id };
  }

  async createForumPost(input: { readonly channelId: string; readonly title: string; readonly content: string; readonly signal?: AbortSignal }): Promise<{ readonly threadId: string }> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel || !channel.isThreadOnly() || !("threads" in channel)) throw new Error(`Discord channel is not a forum: ${input.channelId}`);
    const thread = await channel.threads.create({ name: input.title.slice(0, 100), message: { content: input.content.slice(0, 2_000) } });
    return { threadId: thread.id };
  }

  async archiveThread(input: { readonly channelId: string; readonly threadId: string; readonly signal?: AbortSignal }): Promise<void> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.threadId);
    if (!channel?.isThread()) throw new Error(`Discord channel is not a thread: ${input.threadId}`);
    await channel.setArchived(true);
  }

  async deleteThread(input: { readonly channelId: string; readonly threadId: string; readonly signal?: AbortSignal }): Promise<void> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.threadId);
    if (!channel?.isThread()) throw new Error(`Discord channel is not a thread: ${input.threadId}`);
    await channel.delete();
  }

  async editMessage(input: { readonly channelId: string; readonly messageId: string; readonly content: string; readonly signal?: AbortSignal }): Promise<void> {
    if (input.signal?.aborted) throw input.signal.reason;
    await this.editText(input.channelId, input.messageId, input.content);
  }

  async deleteMessage(input: { readonly channelId: string; readonly messageId: string; readonly signal?: AbortSignal }): Promise<void> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel messages are unavailable: ${input.channelId}`);
    const message = await channel.messages.fetch(input.messageId);
    if (input.signal?.aborted) throw input.signal.reason;
    await message.delete();
  }

  async fetchChannelMessages(input: { readonly channelId: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<readonly { readonly messageId: string; readonly authorId: string; readonly content: string; readonly createdAt: string }[]> {
    if (input.signal?.aborted) throw input.signal.reason;
    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel messages are unavailable: ${input.channelId}`);
    const messages = await channel.messages.fetch({ limit: Math.min(100, Math.max(1, input.limit ?? 50)) });
    return [...messages.values()].map(item => ({ messageId: item.id, authorId: item.author.id, content: item.content, createdAt: item.createdAt.toISOString() }));
  }

  async setRespondToBots(enabled: boolean): Promise<void> { this.respondToBots = enabled; }
  respondsToBots(): boolean { return this.respondToBots; }

  private async normalize(message: Message): Promise<DiscordMessageEnvelope | undefined> {
    if (!this.listener || message.author.id === this.client.user?.id) return undefined;
    const now = Date.now();
    const recent = (this.messageTimes.get(message.author.id) ?? []).filter(timestamp => now - timestamp < 60_000);
    if (recent.length >= 30) return undefined;
    recent.push(now);
    this.messageTimes.set(message.author.id, recent);
    let replyAuthorId: string | undefined;
    if (message.reference?.messageId) {
      try { replyAuthorId = (await message.fetchReference()).author.id; } catch { /* deleted or inaccessible reference */ }
    }
    const thread = message.channel.isThread() ? message.channel : undefined;
    return {
      messageId: message.id,
      channelId: message.channelId,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      ...(thread ? { threadId: thread.id, ...(thread.parentId ? { threadParentId: thread.parentId } : {}), ...(thread.parent?.name ? { threadParentName: thread.parent.name } : {}), ...(thread.parent ? { threadParentKind: thread.parent.isThreadOnly() ? "forum" as const : "channel" as const } : {}) } : {}),
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
    };
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

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseApprovalCustomId(interaction.customId);
    if (!parsed) {
      const button = parseButtonCustomId(interaction.customId);
      if (!button || !this.buttonHandler) return;
      await interaction.deferUpdate();
      try {
        const result = await this.buttonHandler({ ...button, userId: interaction.user.id, channelId: interaction.channelId, ...(interaction.guildId ? { guildId: interaction.guildId } : {}) });
        await interaction.followUp({ content: result.content.slice(0, 1900), ephemeral: true });
      } catch { await interaction.followUp({ content: "Button action failed or is no longer actionable.", ephemeral: true }); }
      return;
    }
    if (!this.approvalHandler) return;
    await interaction.deferUpdate();
    try {
      const result = await this.approvalHandler(parsed.approvalId, parsed.action, { userId: interaction.user.id, channelId: interaction.channelId, ...(interaction.guildId ? { guildId: interaction.guildId } : {}) });
      await interaction.editReply({ content: result.content.slice(0, 1900), components: [] });
    } catch {
      await interaction.followUp({ content: "Approval failed or is no longer actionable.", ephemeral: true });
    }
  }
}
