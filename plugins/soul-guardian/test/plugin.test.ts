import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginStateStore } from "@umiro/core/plugin";
import { createPlugin } from "../src/index.js";

class MemoryState implements PluginStateStore {
  rows = new Map<string, Uint8Array>();
  async read(key: string) { return this.rows.get(key); }
  async writeAtomic(key: string, value: Uint8Array) { this.rows.set(key, value); }
  async remove(key: string) { return this.rows.delete(key); }
  async list(prefix = "") { return [...this.rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.byteLength })); }
}

test("one Soul Guardian entry contributes tools, a job and a command", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "umiro-sg-"));
  await writeFile(join(workspace, "SOUL.md"), "persona");
  const plugin = createPlugin({ pluginId: "soul-guardian", namespace: "soul-guardian", permissionCeiling: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, config: { workspacePath: workspace, schedule: "0 8 * * *", targets: [{ path: "SOUL.md", mode: "alert" }] }, state: new MemoryState(), getSecret: () => undefined });
  await plugin.start?.();
  assert.equal(plugin.contributions.tools?.length, 5);
  assert.equal(plugin.contributions.jobs?.[0]?.id, "soul-guardian.check");
  assert.equal(plugin.contributions.commands?.[0]?.name, "soul-guardian");
});
