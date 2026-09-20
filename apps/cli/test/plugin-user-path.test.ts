import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;

async function createSecretPlugin(directory: string, id: string, optionalSecrets: readonly string[]): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "umiro.plugin.json"), `${JSON.stringify({ schemaVersion: 0, id, version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: id, permissions: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, optionalSecrets, contributes: {} })}\n`);
  await writeFile(join(directory, "index.js"), "export function createPlugin() { return { contributions: {} }; }\n");
}

const secretFixture = [
  "PLUGIN_ONLY=ONLYSECRET_VALUE_123",
  "SHARED_SECRET=SHAREDSECRET_VALUE_456",
  "LLM_API_KEY=CORESECRET_VALUE_789",
  "UNRELATED_SECRET=UNRELATEDSECRET_VALUE_000",
  "",
].join("\n");

test("clean-home Plugin CLI runs install, list, configure, disable, enable, update, and remove", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-plugin-user-path-"));
  const home = join(root, "home"); const plugin = join(root, "sample-plugin"); const env = { ...process.env, UMIRO_HOME: home };
  await mkdir(plugin);
  await writeFile(join(plugin, "umiro.plugin.json"), `${JSON.stringify({ schemaVersion: 0, id: "sample", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "sample", permissions: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, configSchema: { type: "object", additionalProperties: false, required: ["workspacePath"], properties: { workspacePath: { type: "string" }, mode: { type: "string" }, label: { type: "string" } } }, contributes: {} })}\n`);
  await writeFile(join(plugin, "index.js"), "export function createPlugin() { return { contributions: {} }; }\n");
  try {
    await exec(process.execPath, [cli, "init"], { env });
    const installed = await exec(process.execPath, [cli, "plugin", "install", plugin, "--config", "{\"mode\":\"strict\"}"], { env });
    assert.match(installed.stdout, /automatic restart skipped.*user must run `umo restart` manually/);
    assert.match((await exec(process.execPath, [cli, "plugin", "list"], { env })).stdout, /enabled\s+.*sample-plugin/);

    await exec(process.execPath, [cli, "plugin", "configure", plugin, "--config", "{\"label\":\"owner\"}"], { env });
    await exec(process.execPath, [cli, "plugin", "disable", plugin], { env });
    assert.match((await exec(process.execPath, [cli, "plugin", "list"], { env })).stdout, /disabled\s+.*sample-plugin/);
    await exec(process.execPath, [cli, "plugin", "enable", plugin], { env });
    await exec(process.execPath, [cli, "plugin", "update", plugin], { env });

    const configured = JSON.parse(await readFile(join(home, "config", "plugins.json"), "utf8")) as Array<{ enabled: boolean; config?: unknown }>;
    assert.deepEqual(configured, [{ source: plugin, path: plugin, enabled: true, config: { workspacePath: join(home, "workspace"), mode: "strict", label: "owner" } }]);
    await exec(process.execPath, [cli, "plugin", "remove", plugin], { env });
    assert.deepEqual(JSON.parse(await readFile(join(home, "config", "plugins.json"), "utf8")), []);
    await assert.rejects(exec(process.execPath, [cli, "plugin", "enable", plugin], { env }), /plugin is not installed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Plugin changes never control a running service", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-plugin-no-restart-"));
  const home = join(root, "home"); const plugin = join(root, "sample-plugin"); const bin = join(root, "bin"); const systemctlLog = join(root, "systemctl.log");
  await mkdir(plugin); await mkdir(bin);
  await writeFile(join(plugin, "umiro.plugin.json"), `${JSON.stringify({ schemaVersion: 0, id: "sample", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "sample", permissions: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, contributes: {} })}\n`);
  await writeFile(join(plugin, "index.js"), "export function createPlugin() { return { contributions: {} }; }\n");
  await writeFile(join(bin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_SYSTEMCTL_LOG\"\nif [ \"$1 $2\" = \"--user is-active\" ]; then echo active; fi\nexit 0\n");
  await chmod(join(bin, "systemctl"), 0o700);
  const env = { ...process.env, UMIRO_HOME: home, FAKE_SYSTEMCTL_LOG: systemctlLog, PATH: `${bin}:${process.env.PATH ?? ""}` };
  try {
    await exec(process.execPath, [cli, "init"], { env });
    const result = await exec(process.execPath, [cli, "plugin", "install", plugin], { env });
    assert.match(result.stdout, /automatic restart skipped/);
    const calls = await readFile(systemctlLog, "utf8").catch(() => "");
    assert.doesNotMatch(calls, /(?:start|stop|restart).*umiro|umiro.*(?:start|stop|restart)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Plugin install rejects required config that the host cannot derive", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-plugin-required-config-"));
  const home = join(root, "home"); const plugin = join(root, "required-plugin"); const env = { ...process.env, UMIRO_HOME: home };
  await mkdir(plugin);
  await writeFile(join(plugin, "umiro.plugin.json"), `${JSON.stringify({ schemaVersion: 0, id: "required", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "required", permissions: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, configSchema: { type: "object", additionalProperties: false, required: ["workspacePath", "accountId"], properties: { workspacePath: { type: "string" }, accountId: { type: "string" } } }, contributes: {} })}\n`);
  await writeFile(join(plugin, "index.js"), "export function createPlugin() { return { contributions: {} }; }\n");
  try {
    await exec(process.execPath, [cli, "init"], { env });
    await assert.rejects(exec(process.execPath, [cli, "plugin", "install", plugin], { env }), /required.*accountId|accountId.*required/);
    assert.deepEqual(JSON.parse(await readFile(join(home, "config", "plugins.json"), "utf8")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Plugin disable and default remove preserve declared and unrelated secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-plugin-secret-preserve-"));
  const home = join(root, "home"); const target = join(root, "target-plugin"); const shared = join(root, "shared-plugin"); const env = { ...process.env, UMIRO_HOME: home, UMIRO_NO_SYSTEMD: "1" };
  await createSecretPlugin(target, "secret-target", ["PLUGIN_ONLY", "SHARED_SECRET", "LLM_API_KEY"]);
  await createSecretPlugin(shared, "secret-shared", ["SHARED_SECRET"]);
  try {
    await exec(process.execPath, [cli, "init"], { env });
    await exec(process.execPath, [cli, "plugin", "install", target], { env });
    await exec(process.execPath, [cli, "plugin", "install", shared], { env });
    await writeFile(join(home, "config", "secrets.env"), secretFixture, { mode: 0o600 });
    await exec(process.execPath, [cli, "plugin", "disable", target], { env });
    assert.equal(await readFile(join(home, "config", "secrets.env"), "utf8"), secretFixture);
    await exec(process.execPath, [cli, "plugin", "remove", target], { env });
    assert.equal(await readFile(join(home, "config", "secrets.env"), "utf8"), secretFixture);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Plugin remove --remove-secrets deletes only an exclusive optional secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-plugin-secret-cleanup-"));
  const home = join(root, "home"); const target = join(root, "target-plugin"); const shared = join(root, "shared-plugin"); const env = { ...process.env, UMIRO_HOME: home, UMIRO_NO_SYSTEMD: "1" };
  await createSecretPlugin(target, "secret-target", ["PLUGIN_ONLY", "SHARED_SECRET", "LLM_API_KEY"]);
  await createSecretPlugin(shared, "secret-shared", ["SHARED_SECRET"]);
  try {
    await exec(process.execPath, [cli, "init"], { env });
    await exec(process.execPath, [cli, "plugin", "install", target], { env });
    await exec(process.execPath, [cli, "plugin", "install", shared], { env });
    await exec(process.execPath, [cli, "plugin", "disable", shared], { env });
    await writeFile(join(home, "config", "secrets.env"), secretFixture, { mode: 0o600 });
    const invalid = await exec(process.execPath, [cli, "plugin", "disable", target, "--remove-secrets"], { env }).catch(error => error as { stdout?: string; stderr?: string; message?: string });
    assert.match("message" in invalid ? String(invalid.message) : "", /only valid with plugin remove/);
    assert.doesNotMatch(`${invalid.stdout ?? ""}${invalid.stderr ?? ""}`, /ONLYSECRET_VALUE_123|SHAREDSECRET_VALUE_456|CORESECRET_VALUE_789|UNRELATEDSECRET_VALUE_000/);
    const result = await exec(process.execPath, [cli, "plugin", "remove", target, "--remove-secrets"], { env });
    assert.doesNotMatch(`${result.stdout}${result.stderr ?? ""}`, /ONLYSECRET_VALUE_123|SHAREDSECRET_VALUE_456|CORESECRET_VALUE_789|UNRELATEDSECRET_VALUE_000/);
    const secrets = await readFile(join(home, "config", "secrets.env"), "utf8");
    assert.doesNotMatch(secrets, /^PLUGIN_ONLY=/m);
    assert.match(secrets, /^SHARED_SECRET=SHAREDSECRET_VALUE_456$/m);
    assert.match(secrets, /^LLM_API_KEY=CORESECRET_VALUE_789$/m);
    assert.match(secrets, /^UNRELATED_SECRET=UNRELATEDSECRET_VALUE_000$/m);
    assert.equal((await stat(join(home, "config", "secrets.env"))).mode & 0o777, 0o600);
    const entries = JSON.parse(await readFile(join(home, "config", "plugins.json"), "utf8")) as Array<{ source: string; enabled: boolean }>;
    assert.deepEqual(entries, [{ source: shared, path: shared, enabled: false }]);
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

test("GitHub Plugin install accepts a repository tree subdirectory when npm is absent from PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-plugin-github-tree-"));
  const home = join(root, "home"); const source = join(root, "source"); const bin = join(root, "bin");
  const url = "https://github.com/example/monorepo/tree/main/packages/sample"; const installed = join(home, "app", "plugins", "monorepo-sample");
  await mkdir(join(source, "packages", "sample"), { recursive: true }); await mkdir(bin);
  await writeFile(join(source, "packages", "sample", "umiro.plugin.json"), JSON.stringify({ schemaVersion: 0, id: "sample", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "sample", permissions: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" }, contributes: {} }));
  await writeFile(join(source, "packages", "sample", "index.js"), "export function createPlugin() { return { contributions: {} }; }\n");
  await writeFile(join(source, "packages", "sample", "package.json"), JSON.stringify({ name: "sample", scripts: { build: "node -e \"\"" } }));
  await writeFile(join(bin, "git"), "#!/bin/sh\nfor arg do destination=\"$arg\"; done\ncp -R \"$FAKE_PLUGIN_SOURCE\" \"$destination\"\n"); await chmod(join(bin, "git"), 0o700);
  const env = { ...process.env, UMIRO_HOME: home, FAKE_PLUGIN_SOURCE: source, PATH: `${bin}:/usr/bin:/bin` };
  try { await exec(process.execPath, [cli, "init"], { env }); await exec(process.execPath, [cli, "plugin", "install", url], { env }); assert.equal(await readFile(join(installed, "index.js"), "utf8"), "export function createPlugin() { return { contributions: {} }; }\n"); }
  finally { await rm(root, { recursive: true, force: true }); }
});
