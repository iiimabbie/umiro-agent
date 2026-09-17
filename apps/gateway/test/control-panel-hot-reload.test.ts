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
