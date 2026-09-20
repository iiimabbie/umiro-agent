import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginSetupContext } from "@umiro/core/plugin";
import type { ToolExecutionContext } from "@umiro/core/tool";
import { createPlugin } from "../src/index.js";

const authority = { capabilities: ["filesystem.read", "filesystem.write", "shell.execute", "web.fetch"], visibility: { kind: "all" as const }, instructionAuthority: "none" as const };
const execution: ToolExecutionContext = { operationId: "operation", signal: new AbortController().signal, execution: { origin: { kind: "interactive", transport: "test", conversationId: "c" }, actor: { id: "owner", kind: "human", roles: ["owner"] }, authority } };

test("host-tools confines file and shell operations to the configured workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-host-tools-")); const outside = await mkdtemp(join(tmpdir(), "umiro-outside-")); await writeFile(join(root, "input.txt"), "hello"); await writeFile(join(outside, "private.txt"), "private"); await symlink(outside, join(root, "escape"));
  const setup = { pluginId: "host-tools", namespace: "host-tools", permissionCeiling: authority, config: { workspacePath: root }, getSecret() { return undefined; } } satisfies PluginSetupContext;
  const plugin = createPlugin(setup); await plugin.start?.(); const tools = new Map(plugin.contributions.tools!.map(tool => [tool.name, tool]));
  try {
    const list = await tools.get("list_files")!.execute({}, execution); assert.equal(list.ok && list.effectStatus, "not_applicable");
    const read = await tools.get("read_file")!.execute({ path: "input.txt" }, execution); assert.equal(read.ok && (read.output as { content: string }).content, "hello"); assert.equal(read.effectStatus, "not_applicable");
    const write = await tools.get("write_file")!.execute({ path: "output.txt", content: "saved" }, execution); assert.equal(write.ok, true); assert.equal(write.effectStatus, "confirmed"); assert.equal(await readFile(join(root, "output.txt"), "utf8"), "saved");
    const shell = await tools.get("bash")!.execute({ command: "pwd" }, execution); assert.equal(shell.ok, true); assert.equal((shell.ok && shell.output as { stdout: string }).stdout.trim(), root);
    assert.equal((await tools.get("read_file")!.execute({ path: "escape/private.txt" }, execution)).ok, false);
    assert.equal((await tools.get("web_fetch")!.execute({ url: "http://127.0.0.1/private" }, execution)).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("download_file reports the authoritative materialized path and enforces a streamed size limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-host-download-"));
  const previousFetch = globalThis.fetch;
  let oversized = false;
  globalThis.fetch = async () => new Response(oversized ? new Uint8Array(1025) : new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/octet-stream" } });
  const artifact = { id: "download", ownerPrincipalId: "owner", visibility: "shared" as const, mediaType: "application/octet-stream", filename: "file.bin", size: 3, sha256: "a".repeat(64), location: "/unused", state: "stored" as const, createdAt: "now", updatedAt: "now" };
  const setup = {
    pluginId: "host-tools", namespace: "host-tools", permissionCeiling: authority,
    config: { workspacePath: root, maxWebBytes: 1024 }, getSecret() { return undefined; },
    services: { artifacts: {
      async read() { return undefined; },
      async createFromBytes() { return artifact; },
      async createFromFile() { return artifact; },
      async getWorkspaceRelativePath() { return "attachments/downloads/file (2).bin"; },
    } },
  } satisfies PluginSetupContext;
  const plugin = createPlugin(setup); await plugin.start?.();
  const tools = new Map(plugin.contributions.tools!.map(tool => [tool.name, tool]));
  try {
    const downloaded = await tools.get("download_file")!.execute({ url: "https://8.8.8.8/file.bin" }, execution);
    assert.equal(downloaded.ok, true);
    assert.equal(downloaded.ok && (downloaded.output as { path: string }).path, "attachments/downloads/file (2).bin");
    oversized = true;
    assert.equal((await tools.get("download_file")!.execute({ url: "https://8.8.8.8/large.bin" }, execution)).ok, false);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
