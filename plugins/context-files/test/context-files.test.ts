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
  assert.deepEqual(providers.map(provider => provider.id), ["context.soul", "context.agent", "context.owner", "context.memory"]);
  const request = { runId: "run", execution: {} as never, prompt: "hi" };
  const owner = await providers.find(provider => provider.id === "context.owner")!.load(request);
  assert.equal(owner[0]?.content, "owner");
  await plugin.stop?.();
});
