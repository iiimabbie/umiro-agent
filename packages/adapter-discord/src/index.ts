import type { InputEvent } from "@umiro/core/input";
import type { Authority } from "@umiro/core/authorization";
import type { IdentityMappingStore, IdentityResolver, ResolvedIdentity, TransportIdentity } from "@umiro/core/identity";
import type { ExecutionStore } from "@umiro/core/ports";
import type { ArtifactStore } from "@umiro/core";
export * from "./client.js";
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
  readonly attachments?: readonly { readonly id: string; readonly url: string; readonly filename: string; readonly size: number; readonly mediaType?: string }[];
}

/** Converts Discord wire data into the Core's transport-neutral Input Event. */
export function toInputEvent(message: DiscordMessageEnvelope, artifactIds: readonly string[] = []): InputEvent {
  return {
    id: `discord:${message.messageId}`,
    occurredAt: message.createdAt,
    identity: { transport: "discord", externalId: message.authorId, principalId: null },
    conversation: { transport: "discord", externalId: message.threadId ?? message.channelId, kind: message.threadId ? "thread" : (message.guildId ? "channel" : "direct") },
    content: [{ type: "text", text: message.content }, ...artifactIds.map(artifactId => ({ type: "artifact_reference" as const, artifactId }))],
    ...(message.replyToMessageId ? { replyToExternalId: message.replyToMessageId } : {}),
    metadata: { messageId: message.messageId, channelId: message.channelId, ...(message.guildId ? { guildId: message.guildId } : {}), ...(message.threadId ? { threadId: message.threadId } : {}), ...(message.threadParentId ? { threadParentId: message.threadParentId } : {}), ...(message.threadParentName ? { threadParentName: message.threadParentName } : {}), ...(message.threadParentKind ? { threadParentKind: message.threadParentKind } : {}), ...(message.mentionedUserIds ? { mentionedUserIds: [...message.mentionedUserIds] } : {}), ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}), ...(message.replyAuthorId ? { replyAuthorId: message.replyAuthorId } : {}), ...(message.replyToContent !== undefined ? { replyToContent: message.replyToContent } : {}), ...(message.replyToCreatedAt ? { replyToCreatedAt: message.replyToCreatedAt } : {}), ...(message.attachments?.length ? { attachmentCount: message.attachments.length } : {}) },
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

  constructor(private readonly store: IdentityMappingStore, private readonly options: DiscordIdentityResolverOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createPrincipalId = options.createPrincipalId ?? (() => crypto.randomUUID());
  }

  async resolve(identity: TransportIdentity): Promise<ResolvedIdentity> {
    if (identity.transport !== "discord") throw new TypeError(`Discord resolver cannot resolve ${identity.transport}`);
    const owner = identity.externalId === this.options.ownerDiscordId;
    const mapped = await this.store.findOrCreate({
      transport: "discord",
      externalId: identity.externalId,
      principalId: owner ? "owner" : (identity.principalId ?? this.createPrincipalId()),
    }, this.now());
    return {
      principal: { id: mapped.principalId, kind: "human", roles: owner ? ["owner"] : ["member"], identities: [{ transport: "discord", externalId: identity.externalId }], ...(mapped.displayName ? { displayName: mapped.displayName } : {}) },
      authority: owner ? this.options.ownerAuthority : this.options.memberAuthority,
    };
  }
}

export interface DiscordTextTransport {
  sendText(channelId: string, text: string, signal?: AbortSignal): Promise<{ readonly messageId: string }>;
  sendTyping?(channelId: string): Promise<void>;
  sendFiles?(channelId: string, files: readonly { readonly path: string; readonly name?: string }[], signal?: AbortSignal): Promise<{ readonly messageId: string }>;
}

export class DiscordDeliveryWorker {
  constructor(
    private readonly store: Pick<ExecutionStore, "listPendingDeliveries" | "markDeliveryDelivered" | "markDeliveryFailed">,
    private readonly transport: DiscordTextTransport,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly artifacts?: Pick<ArtifactStore, "getArtifact">,
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
        const artifactIds = intent.payload.artifactIds;
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
        } else sent = await this.transport.sendText(intent.destination.channelId, text, signal);
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
