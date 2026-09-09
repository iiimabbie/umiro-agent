import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_EXPLANATIONS, ControlPanelServer } from "../src/control-panel.js";

test("localhost control panel authenticates config and fixed workspace file operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-web-ui-")); const workspace = join(root, "workspace"); const configFile = join(root, "umiro.json");
  await mkdir(workspace); await writeFile(join(workspace, "AGENT.md"), "before\n"); await writeFile(configFile, `${JSON.stringify({ model: "gemma4", discord: {}, webUi: { enabled: true, host: "127.0.0.1", port: 3210 }, plugins: [] })}\n`);
  const server = new ControlPanelServer({ host: "127.0.0.1", port: 0, token: "test-token", configFile, workspace }); await server.start();
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
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test("control panel refuses public bind addresses", () => {
  assert.throws(() => new ControlPanelServer({ host: "0.0.0.0", port: 3210, token: "token", configFile: "/tmp/no", workspace: "/tmp" }), /loopback/);
});
