import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlPanelServer } from "../src/control-panel.js";

test("config save reports hot-applied and restart-required fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-config-reload-"));
  const workspace = join(root, "workspace");
  const configFile = join(root, "umiro.json");
  await mkdir(workspace);
  await writeFile(configFile, '{"model":"old"}\n');
  let appliedConfig: Record<string, unknown> | undefined;
  const server = new ControlPanelServer({
    host: "127.0.0.1", port: 0, token: "token", configFile, workspace,
    async applyConfig(config) { appliedConfig = config; return { applied: ["model", "discord"], restartRequired: ["webUi"] }; },
  });
  await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port()}/api/config`, {
      method: "PUT",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ model: "new", webUi: { enabled: true, host: "127.0.0.1", port: 3210 } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { saved: true, applied: ["model", "discord"], restartRequired: ["webUi"] });
    assert.deepEqual(appliedConfig, { model: "new", webUi: { enabled: true, host: "127.0.0.1", port: 3210 } });
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).model, "new");
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("secret updates expose only status and report live application", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-secret-reload-"));
  const workspace = join(root, "workspace");
  const configFile = join(root, "umiro.json");
  await mkdir(workspace);
  await writeFile(configFile, '{"model":"test"}\n');
  let received: Readonly<Record<string, string>> | undefined;
  let configured = false;
  const server = new ControlPanelServer({
    host: "127.0.0.1", port: 0, token: "token", configFile, workspace,
    secrets: () => ({ DISCORD_TOKEN: configured }),
    async updateSecrets(values) { received = values; configured = true; return { applied: ["DISCORD_TOKEN"], restartRequired: [] }; },
    readiness: () => ({ storage: true, plugins: true, discord: false, scheduler: true, configurationRequired: ["DISCORD_TOKEN"] }),
  });
  await server.start();
  try {
    const endpoint = `http://127.0.0.1:${server.port()}`;
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    const ready = await fetch(`${endpoint}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json() as { status: string }).status, "configuration_required");
    assert.deepEqual(await (await fetch(`${endpoint}/api/secrets`, { headers })).json(), { DISCORD_TOKEN: false });
    const response = await fetch(`${endpoint}/api/secrets`, { method: "PUT", headers, body: JSON.stringify({ DISCORD_TOKEN: "new-token" }) });
    assert.deepEqual(await response.json(), { saved: true, applied: ["DISCORD_TOKEN"], restartRequired: [] });
    assert.deepEqual(received, { DISCORD_TOKEN: "new-token" });
    assert.deepEqual(await (await fetch(`${endpoint}/api/secrets`, { headers })).json(), { DISCORD_TOKEN: true });
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
