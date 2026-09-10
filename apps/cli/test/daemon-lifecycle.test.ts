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

test("systemd user-service path starts, reports readiness, and stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-systemd-rehearsal-"));
  const home = join(root, "home"); const fakeBin = join(root, "bin");
  await mkdir(fakeBin, { recursive: true });
  const systemctl = join(fakeBin, "systemctl");
  await writeFile(systemctl, `#!/bin/sh
state="$UMIRO_HOME/state/fake-systemd.pid"
case "$2" in
  is-active) if [ -f "$state" ] && kill -0 "$(cat "$state")" 2>/dev/null; then echo active; exit 0; fi; echo inactive; exit 3 ;;
  start) node "$UMIRO_GATEWAY_ENTRY" </dev/null >/dev/null 2>&1 & echo $! > "$state"; exit 0 ;;
  stop) if [ -f "$state" ]; then kill "$(cat "$state")" 2>/dev/null || true; rm -f "$state"; fi; exit 0 ;;
  link|daemon-reload|enable|disable) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, UMIRO_HOME: home, UMIRO_GATEWAY_ENTRY: fixture };
  try {
    await exec(process.execPath, [cli, "init"], { env });
    const configFile = join(home, "config", "umiro.json");
    const config = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>;
    await writeFile(configFile, `${JSON.stringify({ ...config, webUi: { enabled: false } }, null, 2)}\n`);
    await mkdir(join(home, "app", "current", "gateway", "dist", "src"), { recursive: true });
    await writeFile(join(home, "app", "current", "gateway", "dist", "src", "main.js"), "// fixture marker\n");
    const started = await exec(process.execPath, [cli, "start"], { env });
    assert.match(started.stdout, /started \(systemd, ready\)/);
    assert.match((await exec(process.execPath, [cli, "status"], { env })).stdout, /running \(systemd, ready\)/);
    const stopped = await exec(process.execPath, [cli, "stop"], { env });
    assert.match(stopped.stdout, /stopped \(systemd\)/);
  } finally {
    try { await exec(process.execPath, [cli, "stop"], { env }); } catch { /* best effort */ }
    await rm(root, { recursive: true, force: true });
  }
});
