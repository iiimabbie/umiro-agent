import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityMappingStore, PersistedTransportIdentity } from "@umiro/core/identity";
import { DiscordIdentityResolver, toInputEvent } from "../src/index.js";

class MemoryMappings implements IdentityMappingStore {
  readonly rows = new Map<string, PersistedTransportIdentity>();
  async find(transport: string, externalId: string) { return this.rows.get(`${transport}:${externalId}`); }
  async findOrCreate(identity: PersistedTransportIdentity) {
    const key = `${identity.transport}:${identity.externalId}`;
    const existing = this.rows.get(key);
    if (existing) return existing;
    this.rows.set(key, identity);
    return identity;
  }
}

const authority = { capabilities: [], visibility: { kind: "all" as const }, instructionAuthority: "full" as const };

test("maps Discord messages and preserves stable principals", async () => {
  const store = new MemoryMappings();
  let sequence = 0;
  const resolver = new DiscordIdentityResolver(store, { ownerDiscordId: "1", ownerAuthority: authority, memberAuthority: authority, createPrincipalId: () => `member-${++sequence}` });
  const first = await resolver.resolve({ transport: "discord", externalId: "2", principalId: null });
  const second = await resolver.resolve({ transport: "discord", externalId: "2", principalId: null });
  assert.equal(first.principal.id, "member-1");
  assert.equal(second.principal.id, "member-1");
  assert.deepEqual((await resolver.resolve({ transport: "discord", externalId: "1", principalId: null })).principal.roles, ["owner"]);
  const event = toInputEvent({ messageId: "m", channelId: "c", guildId: "g", authorId: "2", content: "hi", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(event.conversation.kind, "channel");
  assert.equal(event.content[0]?.type, "text");
});
