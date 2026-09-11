import assert from "node:assert/strict";
import test from "node:test";
import { discordRuntimeContextProvider } from "../src/discord-context.js";

test("Discord thread context exposes its parent Forum as trusted transport metadata", async () => {
  const blocks = await discordRuntimeContextProvider.load({
    runId: "run",
    execution: { actor: { id: "owner", kind: "human", roles: ["owner"] }, authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "full" }, origin: { kind: "interactive", transport: "discord", conversationId: "conversation" } },
    prompt: "post here",
    inputEvent: { id: "discord:message", occurredAt: "now", identity: { transport: "discord", externalId: "owner", principalId: null }, conversation: { transport: "discord", externalId: "thread", kind: "thread" }, content: [{ type: "text", text: "post here" }], metadata: { channelId: "thread", guildId: "guild", threadId: "thread", threadParentId: "forum", threadParentName: "Travel", threadParentKind: "forum" } },
  });
  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0]!.content), { transport: "discord", currentChannel: { id: "thread", kind: "thread" }, guild: { id: "guild" }, thread: { id: "thread", parent: { id: "forum", kind: "forum", name: "Travel" } } });
  assert.equal(blocks[0]!.instructionAuthority, "none");
  assert.equal(blocks[0]!.retention, "essential");
});
