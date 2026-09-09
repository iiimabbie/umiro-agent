import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSingletonLock } from "../src/singleton-lock.js";

test("singleton lock rejects a live owner and replaces a stale lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-lock-")); const path = join(root, "gateway.lock");
  const release = await acquireSingletonLock(path, () => true);
  const record = JSON.parse(await readFile(path, "utf8")) as { pid: number; nonce: string };
  assert.equal(record.pid, process.pid);
  assert.ok(record.nonce);
  await assert.rejects(acquireSingletonLock(path, () => true), /already running/);
  await release();
  await writeFile(path, JSON.stringify({ pid: 999, nonce: "stale", startedAt: "before" }));
  const releaseReplacement = await acquireSingletonLock(path, () => false);
  await releaseReplacement();
});

test("singleton lock fails closed when an existing lock cannot identify its owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-lock-invalid-")); const path = join(root, "gateway.lock");
  await writeFile(path, "");
  await assert.rejects(acquireSingletonLock(path, () => false), /lock is invalid; refusing to remove/);
  assert.equal(await readFile(path, "utf8"), "");
});
