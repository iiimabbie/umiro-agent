import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin } from "../src/index.js";

const execution = { origin: { kind: "interactive" as const, transport: "discord", conversationId: "c" }, actor: { id: "owner", kind: "human" as const, roles: ["owner" as const] }, authority: { capabilities: ["memory.search", "memory.write", "memory.remove"], visibility: { kind: "all" as const }, instructionAuthority: "full" as const } };
const toolContext = { execution, operationId: "op", idempotencyKey: "key", signal: new AbortController().signal };

test("memory entries are created, replaced, read, removed, and projected independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-memory-"));
  const projections = new Map<string, readonly { sourceId: string; text: string }[]>();
  const observedSearch: unknown[] = [];
  try {
    const plugin = createPlugin({
      pluginId: "memory", namespace: "memory", config: { workspacePath: root },
      permissionCeiling: { capabilities: ["memory.search", "memory.write", "memory.remove"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined,
      services: {
        searchDocuments: { async replaceSource(sourceId, documents) { projections.set(sourceId, documents); }, async removeSource() {} },
        conversationSearch: { async search(query, limit, visibility) { observedSearch.push({ query, limit, visibility }); return [{ turnId: "document:memory:entry", conversationId: "source:workspace_file:memory/LESSONS.md#Verify", actorPrincipalId: "namespace:memory", text: "Verify\nCheck the result", rank: 0, documentId: "entry", sourceType: "workspace_file", sourceId: "memory/LESSONS.md#Verify" }]; }, async rebuildSearchProjection() {} },
      },
    });
    await plugin.start?.();
    const tools = new Map(plugin.contributions.tools?.map(tool => [tool.name, tool]));
    assert.deepEqual([...tools.keys()], ["memory_search", "memory_read", "memory_write", "memory_remove"]);
    assert.equal(tools.get("memory_remove")?.policy.tier, "privileged");

    const created = await tools.get("memory_write")!.execute({ file: "LESSONS", heading: "Verify", content: "Check the result" }, toolContext);
    assert.equal(created.ok, true);
    assert.deepEqual(created.ok ? { ...(created.output as { created: boolean; file: string; heading: string }), usage: undefined } : undefined, { created: true, file: "LESSONS", heading: "Verify", usage: undefined });
    assert.deepEqual(created.ok ? (created.output as { usage: { limit: number; entries: number } }).usage : undefined, { chars: 102, limit: 4000, percent: 3, entries: 1 });
    assert.match(await readFile(join(root, "memory", "LESSONS.md"), "utf8"), /## Verify\nCheck the result/);
    assert.deepEqual(projections.get("memory/LESSONS.md")?.map(item => item.sourceId), ["memory/LESSONS.md#Verify"]);

    const replaced = await tools.get("memory_write")!.execute({ file: "LESSONS", heading: "Verify", content: "Check the actual outcome" }, toolContext);
    assert.equal(replaced.ok, true);
    assert.equal(replaced.ok ? (replaced.output as { created: boolean }).created : undefined, false);
    assert.equal((await readFile(join(root, "memory", "LESSONS.md"), "utf8")).match(/^## /gm)?.length, 1);
    const entry = await tools.get("memory_read")!.execute({ file: "LESSONS", heading: "Verify" }, toolContext);
    assert.deepEqual(entry.ok ? entry.output : undefined, { file: "LESSONS", heading: "Verify", content: "Check the actual outcome" });
    const whole = await tools.get("memory_read")!.execute({ file: "LESSONS" }, toolContext);
    assert.match(whole.ok ? String((whole.output as { content: string }).content) : "", /# LESSONS[\s\S]*## Verify/);
    const missing = await tools.get("memory_read")!.execute({ file: "LESSONS", heading: "Missing" }, toolContext);
    assert.equal(missing.ok, false); assert.match(missing.ok ? "" : missing.error.message, /no heading/);

    await writeFile(join(root, "memory", "FACTS.md"), "# FACTS\n\nDurable facts.\n\n## Manual entry\nThe observatory code is ORBIT-42.\n");
    const manualPreserved = await tools.get("memory_write")!.execute({ file: "FACTS", heading: "Second entry", content: "Another fact" }, toolContext);
    assert.equal(manualPreserved.ok, true);
    assert.match(await readFile(join(root, "memory", "FACTS.md"), "utf8"), /## Manual entry[\s\S]*## Second entry/);
    assert.deepEqual(projections.get("memory/FACTS.md")?.map(item => item.sourceId), ["memory/FACTS.md#Manual entry", "memory/FACTS.md#Second entry"]);

    const search = await tools.get("memory_search")!.execute({ query: "ORBIT-42", limit: 3 }, toolContext);
    assert.equal(search.ok, true); assert.equal(search.effectStatus, "not_applicable");
    assert.deepEqual(observedSearch, [{ query: "ORBIT-42", limit: 3, visibility: execution.authority.visibility }]);
    assert.equal(search.ok ? (search.output as { hits: Array<{ sourceId?: string }> }).hits[0]?.sourceId : undefined, "memory/LESSONS.md#Verify");

    const removed = await tools.get("memory_remove")!.execute({ file: "LESSONS", heading: "Verify" }, toolContext);
    assert.equal(removed.ok, true); assert.equal(projections.get("memory/LESSONS.md")?.length, 0);
    assert.doesNotMatch(await readFile(join(root, "memory", "LESSONS.md"), "utf8"), /## Verify/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("memory writes enforce fixed files, entry and file limits without temporary residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-memory-limit-"));
  try {
    const plugin = createPlugin({ pluginId: "memory", namespace: "memory", config: { workspacePath: root, characterLimit: 180 }, permissionCeiling: { capabilities: ["memory.write"], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined });
    await plugin.start?.();
    const write = plugin.contributions.tools!.find(tool => tool.name === "memory_write")!;
    const invalidFile = await write.execute({ file: "../OWNER", heading: "No", content: "No" }, toolContext);
    assert.equal(invalidFile.ok, false); assert.match(invalidFile.ok ? "" : invalidFile.error.message, /file must be one of/);
    const longHeading = await write.execute({ file: "FACTS", heading: "h".repeat(81), content: "No" }, toolContext);
    assert.equal(longHeading.ok, false); assert.match(longHeading.ok ? "" : longHeading.error.message, /heading exceeds 80/);
    const longEntry = await write.execute({ file: "FACTS", heading: "Large", content: "x".repeat(1501) }, toolContext);
    assert.equal(longEntry.ok, false); assert.match(longEntry.ok ? "" : longEntry.error.message, /content exceeds 1500/);
    const full = await write.execute({ file: "FACTS", heading: "Large", content: "x".repeat(100) }, toolContext);
    assert.equal(full.ok, false); assert.match(full.ok ? "" : full.error.message, /FACTS\.md \d+\/180 characters.*memory_write.*memory_remove/);
    assert.equal((await readdir(join(root, "memory"))).some(name => name.startsWith(".FACTS.md.")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("first start creates the current memory files and rejects symlinked memory directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-memory-start-"));
  try {
    const plugin = createPlugin({ pluginId: "memory", namespace: "memory", config: { workspacePath: root }, permissionCeiling: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined });
    await plugin.start?.();
    assert.match(await readFile(join(root, "memory", "ONGOING.md"), "utf8"), /^# ONGOING\n/);
    for (const file of ["PREFERENCES", "LESSONS", "WORKFLOWS", "ONGOING", "FACTS"]) {
      assert.equal((await lstat(join(root, "memory", `${file}.md`))).mode & 0o777, 0o600);
    }
  } finally { await rm(root, { recursive: true, force: true }); }

  const unsafe = await mkdtemp(join(tmpdir(), "umiro-memory-symlink-"));
  const target = await mkdtemp(join(tmpdir(), "umiro-memory-target-"));
  try {
    await symlink(target, join(unsafe, "memory"));
    const plugin = createPlugin({ pluginId: "memory", namespace: "memory", config: { workspacePath: unsafe }, permissionCeiling: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, getSecret: () => undefined });
    await assert.rejects(plugin.start!(), /regular non-symlink directory/);
  } finally { await rm(unsafe, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});
