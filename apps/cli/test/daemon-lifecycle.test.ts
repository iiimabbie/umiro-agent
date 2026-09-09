import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;
const fixture = new URL("../../test/fixture-gateway.mjs", import.meta.url).pathname;

test("fallback daemon start waits for readiness and status reports it", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-daemon-lifecycle-"));
  const home = join(root, "home");
  const env = { ...process.env, UMIRO_HOME: home, UMIRO_NO_SYSTEMD: "1", UMIRO_GATEWAY_ENTRY: fixture };
  try {
    await exec(process.execPath, [cli, "init"], { env });
    const configFile = join(home, "config", "umiro.json");
    const config = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
    await writeFile(configFile, `${JSON.stringify({ ...config, webUi: { enabled: false } }, null, 2)}\n`);
    await mkdir(join(home, "app", "current", "gateway", "dist", "src"), { recursive: true });
    await writeFile(join(home, "app", "current", "gateway", "dist", "src", "main.js"), "// fixture marker\n");

    const started = await exec(process.execPath, [cli, "start"], { env });
    assert.match(started.stdout, /started \d+ \(ready\)/);
    const status = await exec(process.execPath, [cli, "status"], { env });
    assert.match(status.stdout, /running \d+ \(ready\)/);
    await exec(process.execPath, [cli, "stop"], { env });
    assert.match((await exec(process.execPath, [cli, "status"], { env })).stdout, /stopped/);
  } finally {
    try { await exec(process.execPath, [cli, "stop"], { env }); } catch { /* best effort */ }
    await rm(root, { recursive: true, force: true });
  }
});
