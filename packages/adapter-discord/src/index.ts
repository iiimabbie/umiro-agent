import type { InputEvent } from "@umiro/core/input";
import type { Authority } from "@umiro/core/authorization";
import type { IdentityMappingStore, IdentityResolver, ResolvedIdentity, TransportIdentity } from "@umiro/core/identity";
import type { ExecutionStore } from "@umiro/core/ports";
import type { JsonObject } from "@umiro/core/ports";
import type { DeliveryIntent } from "@umiro/core/run";
import type { ArtifactStore } from "@umiro/core";
export * from "./client.js";
export * from "./emoji.js";
export * from "./message-text.js";
export * from "./trigger-policy.js";

export interface DiscordMessageEnvelope {
  readonly messageId: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly threadId?: string;
  readonly threadParentId?: string;
  readonly threadParentName?: string;
  readonly threadParentKind?: "forum" | "channel";
  readonly authorId: string;
  readonly authorBot?: boolean;
  readonly botMentioned?: boolean;
  readonly replyToBot?: boolean;
  readonly authorName?: string;
  readonly content: string;
  readonly createdAt: string;
  readonly mentionedUserIds?: readonly string[];
  readonly replyToMessageId?: string;
  readonly replyAuthorId?: string;
  readonly replyToContent?: string;
  readonly replyToCreatedAt?: string;
  readonly replyToAttachments?: readonly DiscordAttachmentEnvelope[];
  readonly attachments?: readonly DiscordAttachmentEnvelope[];
}

export interface DiscordAttachmentEnvelope {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly size: number;
  readonly mediaType?: string;
  readonly width?: number;
  readonly height?: number;
}

/** Normalize discord.js attachment fields without carrying nulls downstream. */
export function toDiscordAttachmentEnvelope(attachment: { readonly id: string; readonly url: string; readonly name: string; readonly size: number; readonly contentType?: string | null; readonly width?: number | null; readonly height?: number | null }): DiscordAttachmentEnvelope {
  return {
    id: attachment.id,
    url: attachment.url,
    filename: attachment.name,
    size: attachment.size,
    ...(attachment.contentType ? { mediaType: attachment.contentType } : {}),
    ...(typeof attachment.width === "number" && Number.isFinite(attachment.width) ? { width: attachment.width } : {}),
    ...(typeof attachment.height === "number" && Number.isFinite(attachment.height) ? { height: attachment.height } : {}),
  };
}

export function normalizeDiscordMentions(content: string, users: ReadonlyMap<string, string>): string {
  return content.replace(/<@!?(\d{2,32})>/g, (raw, id: string) => {
    const name = users.get(id);
    return name ? `<@${id}>(${name})` : raw;
  });
}

/** Converts Discord wire data into the Core's transport-neutral Input Event. */
export function toInputEvent(message: DiscordMessageEnvelope, artifactIds: readonly string[] = []): InputEvent {
  return {
    id: `discord:${message.messageId}`,
    occurredAt: message.createdAt,
    identity: { transport: "discord", externalId: message.authorId, principalId: null, ...(message.authorName ? { displayName: message.authorName } : {}) },
    conversation: { transport: "discord", externalId: message.threadId ?? message.channelId, kind: message.threadId ? "thread" : (message.guildId ? "channel" : "direct") },
    content: [{ type: "text", text: message.content }, ...artifactIds.map(artifactId => ({ type: "artifact_reference" as const, artifactId }))],
    ...(message.replyToMessageId ? { replyToExternalId: message.replyToMessageId } : {}),
    metadata: { messageId: message.messageId, channelId: message.channelId, ...(message.authorBot !== undefined ? { authorBot: message.authorBot } : {}), ...(message.guildId ? { guildId: message.guildId } : {}), ...(message.threadId ? { threadId: message.threadId } : {}), ...(message.threadParentId ? { threadParentId: message.threadParentId } : {}), ...(message.threadParentName ? { threadParentName: message.threadParentName } : {}), ...(message.threadParentKind ? { threadParentKind: message.threadParentKind } : {}), ...(message.mentionedUserIds ? { mentionedUserIds: [...message.mentionedUserIds] } : {}), ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}), ...(message.replyAuthorId ? { replyAuthorId: message.replyAuthorId } : {}), ...(message.replyToContent !== undefined ? { replyToContent: message.replyToContent } : {}), ...(message.replyToCreatedAt ? { replyToCreatedAt: message.replyToCreatedAt } : {}), ...(message.replyToAttachments?.length ? { replyToAttachmentCount: message.replyToAttachments.length } : {}), ...(message.attachments?.length ? { attachmentCount: message.attachments.length } : {}) },
  };
}

export interface DiscordIdentityResolverOptions {
  readonly ownerDiscordId: string;
  readonly ownerAuthority: Authority;
  readonly memberAuthority: Authority;
  readonly now?: () => string;
  readonly createPrincipalId?: () => string;
}

/** Stable Discord ID mapping. PEOPLE.md is deliberately not consulted for authorization. */
export class DiscordIdentityResolver implements IdentityResolver {
  private readonly now: () => string;
  private readonly createPrincipalId: () => string;
  private ownerDiscordId: string;
  private ownerAuthority: Authority;
  private memberAuthority: Authority;

  constructor(private readonly store: IdentityMappingStore, private readonly options: DiscordIdentityResolverOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createPrincipalId = options.createPrincipalId ?? (() => crypto.randomUUID());
    this.ownerDiscordId = options.ownerDiscordId;
    this.ownerAuthority = options.ownerAuthority;
    this.memberAuthority = options.memberAuthority;
  }

  setOwnerDiscordId(ownerDiscordId: string): void { this.ownerDiscordId = ownerDiscordId; }

  setAuthorities(ownerAuthority: Authority, memberAuthority: Authority): void {
    this.ownerAuthority = ownerAuthority;
    this.memberAuthority = memberAuthority;
  }

  async resolve(identity: TransportIdentity): Promise<ResolvedIdentity> {
    if (identity.transport !== "discord") throw new TypeError(`Discord resolver cannot resolve ${identity.transport}`);
    const owner = identity.externalId === this.ownerDiscordId;
    const mapped = await this.store.findOrCreate({
      transport: "discord",
      externalId: identity.externalId,
      principalId: owner ? "owner" : (identity.principalId ?? this.createPrincipalId()),
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
    }, this.now());
    return {
      principal: { id: mapped.principalId, kind: "human", roles: owner ? ["owner"] : ["member"], identities: [{ transport: "discord", externalId: identity.externalId }], ...(mapped.displayName ? { displayName: mapped.displayName } : {}) },
      authority: owner ? this.ownerAuthority : this.memberAuthority,
    };
  }
}

export interface DiscordTextTransport {
  /** Resolve transport-owned markup before delivery limits are applied. */
  prepareText?(text: string): string;
  sendText(channelId: string, text: string, signal?: AbortSignal): Promise<{ readonly messageId: string }>;
  sendTyping?(channelId: string): Promise<void>;
  sendFiles?(channelId: string, files: readonly { readonly path: string; readonly name?: string }[], signal?: AbortSignal): Promise<{ readonly messageId: string }>;
}

interface FenceState { readonly marker: string; readonly opener: string }

function updateFenceState(text: string, initial: FenceState | undefined): FenceState | undefined {
  let state = initial;
  for (const line of text.split("\n")) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    const rest = match[2]!;
    if (!state) state = { marker, opener: line.trimStart() };
    else if (marker[0] === state.marker[0] && marker.length >= state.marker.length && !rest.trim()) state = undefined;
  }
  return state;
}

function chunkCut(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const newline = text.lastIndexOf("\n", limit - 1);
  return newline >= Math.floor(limit / 2) ? newline + 1 : limit;
}

/** Split Discord text at a hard UTF-16 code-unit limit while keeping fenced
 * code blocks syntactically valid in every chunk. */
export function chunkDiscordText(text: string, limit = 2_000): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 8) throw new TypeError("Discord message limit is too small");
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  let carriedFence: FenceState | undefined;
  while (remaining.length) {
    const prefix = carriedFence ? `${carriedFence.opener}\n` : "";
    let cut = chunkCut(remaining, limit - prefix.length);
    let body = remaining.slice(0, cut);
    let endFence = updateFenceState(body, carriedFence);
    let suffix = endFence ? `\n${endFence.marker}` : "";
    while (prefix.length + body.length + suffix.length > limit) {
      cut = chunkCut(remaining, limit - prefix.length - suffix.length);
      body = remaining.slice(0, cut);
      endFence = updateFenceState(body, carriedFence);
      suffix = endFence ? `\n${endFence.marker}` : "";
    }
    chunks.push(prefix + body + suffix);
    remaining = remaining.slice(cut);
    carriedFence = endFence;
  }
  return chunks;
}

export class DiscordDeliveryWorker {
  constructor(
    private readonly store: Pick<ExecutionStore, "listPendingDeliveries" | "markDeliveryDelivered" | "markDeliveryFailed">,
    private readonly transport: DiscordTextTransport,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly artifacts?: Pick<ArtifactStore, "getArtifact">,
    private readonly suppressDuplicate?: (intent: DeliveryIntent) => Promise<JsonObject | undefined>,
  ) {}

  async drain(signal?: AbortSignal): Promise<{ delivered: number; skipped: number }> {
    let delivered = 0;
    let skipped = 0;
    const drainAt = this.now();
    for (const intent of await this.store.listPendingDeliveries(drainAt)) {
      if (intent.destination.kind !== "discord" || typeof intent.destination.channelId !== "string") {
        skipped++;
        continue;
      }
      try {
        const text = intent.payload.text;
        if (typeof text !== "string") throw new TypeError(`Discord delivery ${intent.id} has no text payload`);
        const duplicateEvidence = await this.suppressDuplicate?.(intent);
        if (duplicateEvidence) {
          await this.store.markDeliveryDelivered(intent.id, this.now(), duplicateEvidence);
          delivered++;
          continue;
        }
        const preparedText = this.transport.prepareText?.(text) ?? text;
        const artifactIds = intent.payload.artifactIds;
        if (!preparedText.trim() && !(Array.isArray(artifactIds) && artifactIds.length)) {
          await this.store.markDeliveryDelivered(intent.id, this.now(), { transport: "discord", channelId: intent.destination.channelId, skipped: "empty_text" });
          delivered++;
          continue;
        }
        let sent: { readonly messageId: string };
        if (Array.isArray(artifactIds) && artifactIds.length) {
          if (!this.transport.sendFiles || !this.artifacts) throw new Error("Discord artifact delivery is unavailable");
          const files: { path: string; name?: string }[] = [];
          for (const id of artifactIds) {
            if (typeof id !== "string") throw new TypeError(`Discord delivery ${intent.id} has an invalid artifact id`);
            const artifact = await this.artifacts.getArtifact(id);
            if (!artifact || artifact.state === "deleted") throw new Error(`artifact ${id} is unavailable`);
            files.push({ path: artifact.location, ...(artifact.filename ? { name: artifact.filename } : {}) });
          }
          sent = await this.transport.sendFiles(intent.destination.channelId, files, signal);
        } else {
          const messageIds: string[] = [];
          for (const chunk of chunkDiscordText(preparedText)) messageIds.push((await this.transport.sendText(intent.destination.channelId, chunk, signal)).messageId);
          sent = { messageId: messageIds[0]! };
          await this.store.markDeliveryDelivered(intent.id, this.now(), { transport: "discord", messageId: sent.messageId, messageIds, channelId: intent.destination.channelId });
          delivered++;
          continue;
        }
        await this.store.markDeliveryDelivered(intent.id, this.now(), { transport: "discord", messageId: sent.messageId, channelId: intent.destination.channelId });
        delivered++;
      } catch (error) {
        const attempts = (intent.attempts ?? 0) + 1;
        const next = new Date(Date.parse(drainAt) + Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 8))).toISOString();
        await this.store.markDeliveryFailed(intent.id, error instanceof Error ? error.message : String(error), next, this.now());
        skipped++;
      }
    }
    return { delivered, skipped };
  }
}
