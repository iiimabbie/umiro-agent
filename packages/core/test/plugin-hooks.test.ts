import assert from "node:assert/strict";
import test from "node:test";
import { PluginHookRegistry } from "../src/plugin/hooks.js";
import type { LogRecord, StructuredLogger } from "../src/observability/logger.js";

test("a failing hook is reported without payload or error-message leakage and sibling hooks continue", async () => {
  const records: LogRecord[] = [];
  const logger: StructuredLogger = { write(record) { records.push(record); } };
  const hooks = new PluginHookRegistry(logger, () => "2026-09-09T01:02:03.000Z");
  const calls: string[] = [];
  hooks.register("broken-plugin", { id: "broken.hook", event: "run.completed", async handle() { throw new Error("secret=do-not-log"); } });
  hooks.register("healthy-plugin", { id: "healthy.hook", event: "run.completed", async handle() { calls.push("healthy"); } });

  await hooks.emit("run.completed", { privateValue: "also-do-not-log" });

  assert.deepEqual(calls, ["healthy"]);
  assert.deepEqual(records, [{
    level: "error",
    event: "plugin.hook.failed",
    message: "Plugin hook failed",
    occurredAt: "2026-09-09T01:02:03.000Z",
    pluginId: "broken-plugin",
    data: { hookId: "broken.hook", hookEvent: "run.completed", errorName: "Error" },
  }]);
  assert.doesNotMatch(JSON.stringify(records), /do-not-log/);
});

test("a failing logger does not escape the hook isolation boundary", async () => {
  const hooks = new PluginHookRegistry({ write() { throw new Error("sink unavailable"); } });
  hooks.register("broken-plugin", { id: "broken.hook", event: "run.completed", async handle() { throw new Error("hook failed"); } });
  await assert.doesNotReject(hooks.emit("run.completed", {}));
});
