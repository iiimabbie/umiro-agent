import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;

test("clean-home Plugin CLI runs install, list, configure, disable, enable, update, and remove", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-plugin-user-path-"));
  const home = join(root, "home"); const plugin = join(root, "sample-plugin"); const env = { ...process.env, UMIRO_HOME: home };
  await mkdir(plugin);
  await writeFile(join(plugin, "umiro.plugin.json"), `${JSON.stringify({ schemaVersion: 0, id: "sample", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "sample", permissions: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, contributes: {} })}\n`);
  await writeFile(join(plugin, "index.js"), "export function createPlugin() { return { contributions: {} }; }\n");
  try {
    await exec(process.execPath, [cli, "init"], { env });
    await exec(process.execPath, [cli, "plugin", "install", plugin], { env });
    assert.match((await exec(process.execPath, [cli, "plugin", "list"], { env })).stdout, /enabled\s+.*sample-plugin/);

    await exec(process.execPath, [cli, "plugin", "configure", plugin, "--config", "{\"mode\":\"strict\"}"], { env });
    await exec(process.execPath, [cli, "plugin", "disable", plugin], { env });
    assert.match((await exec(process.execPath, [cli, "plugin", "list"], { env })).stdout, /disabled\s+.*sample-plugin/);
    await exec(process.execPath, [cli, "plugin", "enable", plugin], { env });
    await exec(process.execPath, [cli, "plugin", "update", plugin], { env });

    const configured = JSON.parse(await readFile(join(home, "config", "plugins.json"), "utf8")) as Array<{ enabled: boolean; config?: unknown }>;
    assert.deepEqual(configured, [{ source: plugin, path: plugin, enabled: true, config: { mode: "strict" } }]);
    await exec(process.execPath, [cli, "plugin", "remove", plugin], { env });
    assert.deepEqual(JSON.parse(await readFile(join(home, "config", "plugins.json"), "utf8")), []);
    await assert.rejects(exec(process.execPath, [cli, "plugin", "enable", plugin], { env }), /plugin is not installed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("GitHub Plugin update builds a candidate before replacing the installed version", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-plugin-github-update-"));
  const home = join(root, "home"); const source = join(root, "source"); const bin = join(root, "bin");
  const url = "https://github.com/example/sample.git"; const installed = join(home, "app", "plugins", "sample");
  await mkdir(source); await mkdir(bin);
  await writeFile(join(source, "umiro.plugin.json"), `${JSON.stringify({ schemaVersion: 0, id: "sample", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "sample", permissions: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, contributes: {} })}\n`);
  await writeFile(join(source, "index.js"), "export function createPlugin() { return { contributions: {} }; }\n");
  await writeFile(join(source, "package.json"), `${JSON.stringify({ name: "sample", scripts: { build: "ignored-by-fake" } })}\n`);
  await writeFile(join(source, "version.txt"), "v1\n");
  await writeFile(join(bin, "git"), "#!/bin/sh\nfor arg do destination=\"$arg\"; done\ncp -R \"$FAKE_PLUGIN_SOURCE\" \"$destination\"\n");
  await writeFile(join(bin, "npm"), "#!/bin/sh\nif [ \"$FAKE_BUILD_FAIL\" = \"1\" ] && [ \"$1\" = \"run\" ]; then exit 42; fi\nexit 0\n");
  await chmod(join(bin, "git"), 0o700); await chmod(join(bin, "npm"), 0o700);
  const env = { ...process.env, UMIRO_HOME: home, FAKE_PLUGIN_SOURCE: source, PATH: `${bin}:${process.env.PATH ?? ""}` };
  try {
    await exec(process.execPath, [cli, "init"], { env });
    await exec(process.execPath, [cli, "plugin", "install", url], { env });
    assert.equal(await readFile(join(installed, "version.txt"), "utf8"), "v1\n");

    await writeFile(join(source, "version.txt"), "v2\n");
    await assert.rejects(exec(process.execPath, [cli, "plugin", "update", url], { env: { ...env, FAKE_BUILD_FAIL: "1" } }));
    assert.equal(await readFile(join(installed, "version.txt"), "utf8"), "v1\n");

    await exec(process.execPath, [cli, "plugin", "update", url], { env });
    assert.equal(await readFile(join(installed, "version.txt"), "utf8"), "v2\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
