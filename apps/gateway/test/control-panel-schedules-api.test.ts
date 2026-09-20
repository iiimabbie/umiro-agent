import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlPanelServer, type ControlPanelSchedules } from "../src/control-panel.js";
import type { ControlPanelScheduleView } from "../src/control-panel-schedules.js";

const base = (id: string, owner: ControlPanelScheduleView["owner"]): ControlPanelScheduleView => ({
  id, name: id, enabled: true, schedule: { kind: "cron", expression: "0 8 * * *" }, timezone: "UTC", nextFireAt: null, owner,
  actions: owner.kind === "user" ? { canToggle: true, canEdit: true, canDelete: true } : { canToggle: false, canEdit: false, canDelete: false },
  ...(owner.kind === "user" ? { prompt: "user prompt" } : {}),
});

test("control-panel schedule API exposes ownership and rejects managed mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-schedules-api-"));
  const workspace = join(root, "workspace"); const configFile = join(root, "umiro.json");
  await mkdir(workspace, { recursive: true }); await writeFile(configFile, JSON.stringify({ model: "test" }));
  const views = [base("user", { kind: "user" }), base("tool:diary", { kind: "plugin", pluginId: "diary" }), base("tool:conversation-auto-archive", { kind: "system", systemId: "conversation-auto-archive" })];
  let mutationCalls = 0; let created: unknown;
  const schedules: ControlPanelSchedules = {
    async list() { return views; },
    async create(input) { created = input; return input; },
    async setEnabled() { mutationCalls += 1; return views[0]; },
    async update() { mutationCalls += 1; return views[0]; },
    async remove() { mutationCalls += 1; return true; },
    async preview() { return null; },
  };
  const server = new ControlPanelServer({ host: "127.0.0.1", port: 0, token: "token", configFile, workspace, schedules }); await server.start();
  const endpoint = `http://127.0.0.1:${server.port()}`; const headers = { authorization: "Bearer token", "content-type": "application/json" };
  try {
    const listed = await (await fetch(`${endpoint}/api/schedules`, { headers })).json();
    assert.deepEqual(listed, views);
    for (const id of ["tool:diary", "tool:conversation-auto-archive"]) {
      assert.equal((await fetch(`${endpoint}/api/schedules/${id}`, { method: "PATCH", headers, body: JSON.stringify({ enabled: false }) })).status, 409);
      assert.equal((await fetch(`${endpoint}/api/schedules/${id}`, { method: "PATCH", headers, body: JSON.stringify({ name: "changed", kind: "cron", expression: "0 9 * * *", timezone: "UTC", prompt: "changed" }) })).status, 409);
      assert.equal((await fetch(`${endpoint}/api/schedules/${id}`, { method: "DELETE", headers })).status, 409);
    }
    assert.equal(mutationCalls, 0);
    assert.equal((await fetch(`${endpoint}/api/schedules/missing`, { method: "DELETE", headers })).status, 404);
    assert.equal((await fetch(`${endpoint}/api/schedules`, { method: "POST", headers, body: JSON.stringify({ name: "new", kind: "cron", expression: "0 9 * * *", timezone: "UTC", prompt: "hello", owner: { kind: "system" }, jobRef: "system:bad", pluginId: "diary" }) })).status, 201);
    assert.deepEqual(created, { name: "new", kind: "cron", expression: "0 9 * * *", timezone: "UTC", prompt: "hello" });
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});
