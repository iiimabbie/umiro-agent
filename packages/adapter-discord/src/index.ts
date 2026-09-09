import type { InputEvent } from "@umiro/core/input";
import type { Authority } from "@umiro/core/authorization";
import type { IdentityMappingStore, IdentityResolver, ResolvedIdentity, TransportIdentity } from "@umiro/core/identity";

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
      principal: { id: mapped.principalId, kind: "human", roles: owner ? ["owner"] : ["member"], ...(mapped.displayName ? { displayName: mapped.displayName } : {}) },
      authority: owner ? this.options.ownerAuthority : this.options.memberAuthority,
    };
  }
}
