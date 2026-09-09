import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../src/index.js";

test("built-in context provider loads OWNER with the other workspace files", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-context-"));
  for (const [name, content] of [["SOUL.md", "soul"], ["AGENT.md", "agent"], ["OWNER.md", "owner"], ["MEMORY.md", "memory"]] as const) await writeFile(join(root, name), content);
  const plugin = createPlugin({ pluginId: "context-files", namespace: "context-files", permissionCeiling: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, config: { workspacePath: root }, getSecret: () => undefined });
  await plugin.start?.();
  const providers = plugin.contributions.contextProviders ?? [];
  assert.deepEqual(providers.map(provider => provider.id), ["context.soul", "context.agent", "context.owner", "context.memory", "context.conversation_history"]);
  const request = { runId: "run", execution: {} as never, prompt: "hi" };
  const owner = await providers.find(provider => provider.id === "context.owner")!.load(request);
  assert.equal(owner[0]?.content, "owner");
  const ownerTools = plugin.contributions.tools ?? [];
  const add = ownerTools.find(tool => tool.name === "owner_profile_add")!;
  const replace = ownerTools.find(tool => tool.name === "owner_profile_replace")!;
  assert.equal((await add.execute({ content: "稱呼：主人" }, {} as never) as { ok: boolean }).ok, true);
  assert.match(await (await import("node:fs/promises")).readFile(join(root, "OWNER.md"), "utf8"), /稱呼：主人/);
  assert.equal((await replace.execute({ oldText: "稱呼：主人", newText: "稱呼：Owner" }, {} as never) as { ok: boolean }).ok, true);
  const history = await providers.find(provider => provider.id === "context.conversation_history")!.load({ ...request, conversationCompaction: { conversationId: "c", throughSequence: 3, sourceHash: "abc", summary: "先前談過授權邊界", updatedAt: "now" }, recentHistory: [{ turn: { id: "t", conversationId: "c", sequence: 4, actorPrincipalId: "user", inputEventId: "e", content: [{ type: "text", text: "我叫小明" }], createdAt: "now" }, assistantText: "記住了" }] });
  assert.deepEqual(history.map(block => block.id), ["context.conversation_history:compacted", "context.conversation_history:recent"]);
  assert.match(history[0]?.content ?? "", /先前談過授權邊界/);
  assert.match(history[1]?.content ?? "", /我叫小明[\s\S]*記住了/);
  await plugin.stop?.();
});
