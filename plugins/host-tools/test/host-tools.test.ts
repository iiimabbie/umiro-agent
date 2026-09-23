import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    const webFetch = tools.get("web_fetch")!;
    assert.equal((await webFetch.execute({ url: "http://127.0.0.1/private" }, execution)).ok, false);
    assert.match(webFetch.description, /\[Official status page\]\(https:\/\/status\.example\/\) \| \[Incident page\]\(https:\/\/status\.example\/incidents\/123\)/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("agent shell cannot control the Umiro service", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-host-service-control-"));
  const setup = { pluginId: "host-tools", namespace: "host-tools", permissionCeiling: authority, config: { workspacePath: root }, getSecret() { return undefined; } } satisfies PluginSetupContext;
  const plugin = createPlugin(setup); await plugin.start?.();
  const bash = plugin.contributions.tools!.find(tool => tool.name === "bash")!;
  try {
    for (const command of ["umo restart", "/home/user/.umiro/bin/umo stop", "systemctl --user restart umiro.service", "service umiro start"]) {
      const result = await bash.execute({ command }, execution);
      assert.equal(result.ok, false, command);
      assert.match(result.ok ? "" : result.error.message, /user must do that manually/);
    }
    assert.equal((await bash.execute({ command: "printf 'plugin install remains allowed'" }, execution)).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read_file loads supported workspace attachments as model-only metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-host-media-"));
  await mkdir(join(root, "attachments"), { recursive: true });
  await writeFile(join(root, "attachments/photo.png"), new Uint8Array([1, 2, 3]));
  const setup = {
    pluginId: "host-tools", namespace: "host-tools", permissionCeiling: authority,
    config: { workspacePath: root }, getSecret() { return undefined; },
    services: { artifacts: {
      async resolveWorkspaceFileForModel(input: { sourcePath: string; ownerPrincipalId: string }) { return { id: "artifact-photo", ownerPrincipalId: input.ownerPrincipalId, visibility: "shared" as const, mediaType: "image/png", filename: "photo.png", size: 3, sha256: "a".repeat(64), location: "/hidden", state: "stored" as const, createdAt: "now", updatedAt: "now" }; },
      async read() { return undefined; }, async createFromBytes() { throw new Error("unused"); }, async createFromWorkspaceFile() { throw new Error("unused"); }, async moveWorkspaceFile() { throw new Error("unused"); }, async getWorkspaceRelativePath() { return undefined; },
    } },
  } satisfies PluginSetupContext;
  const plugin = createPlugin(setup); await plugin.start?.();
  const read = await plugin.contributions.tools!.find(tool => tool.name === "read_file")!.execute({ path: "workspace/attachments/photo.png" }, execution);
  try {
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok && read.modelInputArtifactIds, ["artifact-photo"]);
    assert.deepEqual(read.ok && read.output, { path: "attachments/photo.png", filename: "photo.png", mediaType: "image/png", size: 3, artifactId: "artifact-photo", loadedForModel: true });
    assert.equal(read.ok && "artifactIds" in read, false);
  } finally { await rm(root, { recursive: true, force: true }); }
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
      async createFromWorkspaceFile() { return artifact; },
      async moveWorkspaceFile() { return { oldPath: "attachments/a", newPath: "attachments/b" }; },
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

test("move_file validates attachment paths before invoking the artifact service", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-host-move-"));
  let calls = 0;
  let shouldThrow = false;
  const setup = {
    pluginId: "host-tools", namespace: "host-tools", permissionCeiling: authority,
    config: { workspacePath: root }, getSecret() { return undefined; },
    services: { artifacts: {
      async resolveWorkspaceFileForModel() { throw new Error("unused"); },
      async read() { return undefined; },
      async createFromBytes() { throw new Error("unused"); },
      async createFromWorkspaceFile() { throw new Error("unused"); },
      async moveWorkspaceFile() { calls += 1; if (shouldThrow) throw new Error("filesystem move failed"); return { oldPath: "attachments/generated/a.png", newPath: "attachments/.trash/a.png" }; },
      async getWorkspaceRelativePath() { return undefined; },
    } },
  } satisfies PluginSetupContext;
  const plugin = createPlugin(setup); await plugin.start?.();
  const move = plugin.contributions.tools!.find(tool => tool.name === "move_file")!;
  try {
    const invalid = await move.execute({ source: "attachments/generated/a.png", destination: ".trash/a.png" }, execution);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.effectStatus, "not_applicable");
    assert.equal(invalid.ok ? "" : invalid.error.code, "host_tool_error");
    assert.match(invalid.ok ? "" : invalid.error.message, /inside workspace attachments/);
    assert.equal(calls, 0);

    const traversal = await move.execute({ source: "attachments/../outside/a.png", destination: "attachments/.trash/a.png" }, execution);
    assert.equal(traversal.ok, false);
    assert.equal(traversal.effectStatus, "not_applicable");
    assert.equal(calls, 0);

    const valid = await move.execute({ source: "workspace/attachments/generated/a.png", destination: "attachments/.trash/a.png" }, execution);
    assert.equal(valid.ok, true);
    assert.equal(valid.effectStatus, "confirmed");
    assert.equal(calls, 1);

    shouldThrow = true;
    const failedMove = await move.execute({ source: "attachments/generated/a.png", destination: "attachments/.trash/a.png" }, execution);
    assert.equal(failedMove.ok, false);
    assert.equal(failedMove.effectStatus, "unknown");
    assert.equal(calls, 2);

    assert.match(move.description, /attachments\/\.trash/);
    assert.match(plugin.contributions.tools!.find(tool => tool.name === "read_file")!.description, /binary model input/);
    assert.match(plugin.contributions.tools!.find(tool => tool.name === "bash")!.description, /lifecycle controls remain user-operated/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
