import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_EXPLANATIONS, ControlPanelServer } from "../src/control-panel.js";

test("localhost control panel authenticates config and fixed workspace file operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-web-ui-")); const workspace = join(root, "workspace"); const configFile = join(root, "umiro.json");
  await mkdir(workspace); await writeFile(join(workspace, "AGENT.md"), "before\n"); await writeFile(configFile, `${JSON.stringify({ model: "gemma4", discord: {}, webUi: { enabled: true, host: "127.0.0.1", port: 3210 }, plugins: [] })}\n`);
  const schedules = [{ id: "schedule-1", name: "daily", enabled: true, schedule: { kind: "cron", expression: "0 8 * * *" } }]; let created: unknown; let enabled: unknown; let removed: unknown;
  let pluginAction: unknown; let approvalAction: unknown;
  const server = new ControlPanelServer({ host: "127.0.0.1", port: 0, token: "test-token", configFile, workspace, schedules: {
    async list() { return schedules; }, async create(input) { created = input; return { id: "new", ...input }; }, async setEnabled(id, value) { enabled = [id, value]; return { id, enabled: value }; }, async remove(id) { removed = id; return true; },
  }, plugins: { async list() { return [{ source: "builtin:memory", enabled: true }]; }, async run(...args) { pluginAction = args; return { ok: true }; } }, approvals: { async list() { return [{ id: "approval-1", operation: "write", details: "{}", expiresAt: "later" }]; }, async resolve(...args) { approvalAction = args; return { approval: args[1] }; } }, runtime: () => ({ status: "running", bot: { tag: "dev" } }) }); await server.start();
  const endpoint = `http://127.0.0.1:${server.port()}`; const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${endpoint}/api/config`)).status, 401);
    const schema = await (await fetch(`${endpoint}/api/schema`, { headers })).json(); assert.deepEqual(schema, CONFIG_EXPLANATIONS);
    const updated = { model: "new-model", discord: { allowedGuilds: ["g"] }, webUi: { enabled: true, host: "127.0.0.1", port: 4000 }, plugins: [] };
    assert.equal((await fetch(`${endpoint}/api/config`, { method: "PUT", headers, body: JSON.stringify(updated) })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), updated);
    assert.equal((await fetch(`${endpoint}/api/workspace/AGENT.md`, { method: "PUT", headers, body: JSON.stringify({ content: "after\n" }) })).status, 200);
    assert.equal(await readFile(join(workspace, "AGENT.md"), "utf8"), "after\n");
    assert.equal((await fetch(`${endpoint}/api/workspace/SECRET.md`, { headers })).status, 404);
    assert.deepEqual(await (await fetch(`${endpoint}/api/schedules`, { headers })).json(), schedules);
    assert.equal((await fetch(`${endpoint}/api/schedules`, { method: "POST", headers, body: JSON.stringify({ name: "later", kind: "once", at: "2026-09-10T00:00:00.000Z", timezone: "Asia/Taipei", prompt: "提醒我" }) })).status, 201);
    assert.deepEqual(created, { name: "later", kind: "once", at: "2026-09-10T00:00:00.000Z", timezone: "Asia/Taipei", prompt: "提醒我" });
    assert.equal((await fetch(`${endpoint}/api/schedules/schedule-1`, { method: "PATCH", headers, body: JSON.stringify({ enabled: false }) })).status, 200); assert.deepEqual(enabled, ["schedule-1", false]);
    assert.equal((await fetch(`${endpoint}/api/schedules/schedule-1`, { method: "DELETE", headers })).status, 200); assert.equal(removed, "schedule-1");
    assert.deepEqual(await (await fetch(`${endpoint}/api/plugins`, { headers })).json(), [{ source: "builtin:memory", enabled: true }]);
    assert.equal((await fetch(`${endpoint}/api/plugins/action`, { method: "POST", headers, body: JSON.stringify({ action: "configure", source: "builtin:memory", config: { limit: 10 } }) })).status, 200);
    assert.deepEqual(pluginAction, ["configure", "builtin:memory", undefined, { limit: 10 }]);
    assert.deepEqual(await (await fetch(`${endpoint}/api/runtime`, { headers })).json(), { status: "running", bot: { tag: "dev" } });
    assert.equal((await fetch(`${endpoint}/api/approvals/approval-1`, { method: "POST", headers, body: JSON.stringify({ action: "approve" }) })).status, 200);
    assert.deepEqual(approvalAction, ["approval-1", "approve"]);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test("control panel refuses public bind addresses", () => {
  assert.throws(() => new ControlPanelServer({ host: "0.0.0.0", port: 3210, token: "token", configFile: "/tmp/no", workspace: "/tmp" }), /loopback/);
});
