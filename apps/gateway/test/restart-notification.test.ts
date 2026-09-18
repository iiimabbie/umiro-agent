import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completePendingRestart, savePendingRestart } from "../src/restart-notification.js";

test("restart state survives the old process and completes the original Discord reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "umiro-restart-"));
  const path = join(directory, "pending-restart.json");
  await savePendingRestart(path, { applicationId: "application", token: "interaction-token" }, 1_000);
  assert.equal((JSON.parse(await readFile(path, "utf8")) as { token: string }).token, "interaction-token");
  let requestUrl = "";
  let requestBody = "";
  const completed = await completePendingRestart(path, "Umiro", { now: 2_000, fetch: async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return new Response(null, { status: 204 });
  } });
  assert.equal(completed, true);
  assert.equal(requestUrl, "https://discord.com/api/v10/webhooks/application/interaction-token/messages/@original");
  assert.deepEqual(JSON.parse(requestBody), { content: "Umiro says Hi again 🫶🏻" });
  assert.equal(await completePendingRestart(path, "Umiro", { now: 2_000 }), false);
});

test("expired restart state is discarded without calling Discord", async () => {
  const directory = await mkdtemp(join(tmpdir(), "umiro-restart-expired-"));
  const path = join(directory, "pending-restart.json");
  await savePendingRestart(path, { applicationId: "application", token: "interaction-token" }, 1_000);
  let called = false;
  assert.equal(await completePendingRestart(path, "Umiro", { now: 15 * 60 * 1_000, fetch: async () => { called = true; return new Response(null, { status: 204 }); } }), false);
  assert.equal(called, false);
});

test("failed completion remains durable for a later startup retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "umiro-restart-retry-"));
  const path = join(directory, "pending-restart.json");
  await savePendingRestart(path, { applicationId: "application", token: "interaction-token" }, 1_000);
  await assert.rejects(() => completePendingRestart(path, "Umiro", { now: 2_000, fetch: async () => new Response("unavailable", { status: 503 }) }), /503 unavailable/);
  assert.equal((JSON.parse(await readFile(path, "utf8")) as { applicationId: string }).applicationId, "application");
});
