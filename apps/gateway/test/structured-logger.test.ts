import assert from "node:assert/strict";
import test from "node:test";
import { JsonLineLogger } from "../src/structured-logger.js";

test("JSON line logger emits one parseable structured record", () => {
  let output = "";
  const logger = new JsonLineLogger(line => { output += line; });
  logger.write({ level: "error", event: "plugin.hook.failed", message: "Plugin hook failed", occurredAt: "now", pluginId: "sample" });
  assert.equal(output.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(output), { level: "error", event: "plugin.hook.failed", message: "Plugin hook failed", occurredAt: "now", pluginId: "sample" });
});
