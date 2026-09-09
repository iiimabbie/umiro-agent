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

test("JSON line logger retains only a bounded newest-first control-panel view", () => {
  const logger = new JsonLineLogger(() => undefined, 2);
  for (const event of ["one", "two", "three"]) logger.write({ level: "info", event, message: event, occurredAt: event });
  assert.deepEqual(logger.list(2).map(record => record.event), ["three", "two"]);
  assert.throws(() => logger.list(3), /between 1 and 2/);
});
