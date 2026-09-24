import assert from "node:assert/strict";
import test from "node:test";
import { fallbackRestartEnvironment, isSystemdManaged } from "../src/supervisor.js";

test("supervisor detection uses the explicit manager marker instead of INVOCATION_ID", () => {
  assert.equal(isSystemdManaged({ INVOCATION_ID: "ambient-systemd-value" }), false);
  assert.equal(isSystemdManaged({ INVOCATION_ID: "ambient-systemd-value", UMIRO_SERVICE_MANAGER: "fallback" }), false);
  assert.equal(isSystemdManaged({ UMIRO_SERVICE_MANAGER: "systemd" }), true);
});

test("fallback restart children retain the fallback marker", () => {
  assert.deepEqual(fallbackRestartEnvironment({ INVOCATION_ID: "ambient-systemd-value", UMIRO_SERVICE_MANAGER: "systemd" }), {
    UMIRO_SERVICE_MANAGER: "fallback",
  });
});
