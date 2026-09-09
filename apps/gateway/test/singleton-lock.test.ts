import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSingletonLock } from "../src/singleton-lock.js";

test("singleton lock rejects a live owner and replaces a stale lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-lock-")); const path = join(root, "gateway.lock");
  const release = await acquireSingletonLock(path, () => true);
  await assert.rejects(acquireSingletonLock(path, () => true), /already running/);
  await release();
  await writeFile(path, JSON.stringify({ pid: 999, nonce: "stale", startedAt: "before" }));
  const releaseReplacement = await acquireSingletonLock(path, () => false);
  await releaseReplacement();
});
