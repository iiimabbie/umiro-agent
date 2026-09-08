import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRunTransition,
  assertStepTransition,
  canTransitionRun,
  isTerminalRunState,
} from "../src/index.js";

test("run lifecycle permits waiting and resumption without invented main states", () => {
  assert.equal(canTransitionRun("queued", "running"), true);
  assert.equal(canTransitionRun("running", "waiting"), true);
  assert.equal(canTransitionRun("waiting", "running"), true);
  assert.equal(canTransitionRun("running", "succeeded"), true);
  assert.equal(isTerminalRunState("succeeded"), true);
});

test("terminal runs and steps reject further transitions", () => {
  assert.throws(() => assertRunTransition("succeeded", "running"), /invalid run transition/);
  assert.throws(() => assertRunTransition("failed", "running"), /invalid run transition/);
  assert.throws(() => assertStepTransition("succeeded", "running"), /invalid step transition/);
});
