import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = new URL("../src/main.js", import.meta.url).pathname;

test("uninstall removes release and launchers while preserving user data by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-uninstall-")); const home = join(root, "home"); const env = { ...process.env, UMIRO_HOME: home, UMIRO_NO_SYSTEMD: "1" };
  try {
    await exec(process.execPath, [cli, "init"], { env });
    await writeFile(join(home, "workspace", "SOUL.md"), "keep me\n");
    await exec(process.execPath, [cli, "uninstall"], { env });
    await access(join(home, "config", "umiro.json")); await access(join(home, "workspace", "SOUL.md"));
    await assert.rejects(access(join(home, "app"))); await assert.rejects(access(join(home, "bin")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uninstall --purge removes the validated installation root", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-purge-")); const home = join(root, "home"); const env = { ...process.env, UMIRO_HOME: home, UMIRO_NO_SYSTEMD: "1" };
  try {
    await exec(process.execPath, [cli, "init"], { env });
    await exec(process.execPath, [cli, "uninstall", "--purge"], { env });
    await assert.rejects(access(home));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uninstall --purge rejects an unsafe installation root before mutation", async () => {
  const env = { ...process.env, UMIRO_HOME: process.cwd(), UMIRO_NO_SYSTEMD: "1" };
  await assert.rejects(exec(process.execPath, [cli, "uninstall", "--purge"], { env }), /refusing to purge unsafe UMIRO_HOME/);
});
