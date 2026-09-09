import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../src/index.js";

test("memory tools apply caller visibility and atomically maintain MEMORY.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-memory-"));
  const observed: unknown[] = [];
  try {
    await writeFile(join(root, "MEMORY.md"), "# MEMORY\n");
    const plugin = createPlugin({
      pluginId: "memory", namespace: "memory", config: { workspacePath: root },
      permissionCeiling: { capabilities: ["memory.search", "memory.write", "memory.remove"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined,
      services: { conversationSearch: { async search(query, limit, visibility) { observed.push({ query, limit, visibility }); return [{ turnId: "t", conversationId: "c", actorPrincipalId: "p", text: "found", rank: 0 }]; }, async rebuildSearchProjection() {} } },
    });
    await plugin.start?.();
    const tools = new Map(plugin.contributions.tools?.map(tool => [tool.name, tool]));
    const visibility = { kind: "restricted" as const, principalIds: ["p"], labels: [], resources: [] };
    const context = { execution: { origin: { kind: "interactive" as const, transport: "discord", conversationId: "c" }, actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, authority: { capabilities: ["memory.search", "memory.write", "memory.remove"], visibility, instructionAuthority: "full" as const } }, operationId: "op", idempotencyKey: "key", signal: new AbortController().signal };
    const search = await tools.get("memory_search")!.execute({ query: "found", limit: 3 }, context);
    assert.equal(search.ok, true); assert.deepEqual(observed, [{ query: "found", limit: 3, visibility }]);
    assert.equal((await tools.get("memory_add")!.execute({ content: "- durable fact" }, context)).ok, true);
    assert.equal((await tools.get("memory_replace")!.execute({ oldText: "durable", newText: "lasting" }, context)).ok, true);
    assert.match(await readFile(join(root, "MEMORY.md"), "utf8"), /lasting fact/);
    assert.equal((await tools.get("memory_remove")!.execute({ text: "- lasting fact" }, context)).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
