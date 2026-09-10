import assert from "node:assert/strict";
import test from "node:test";
import { SteerGate } from "../src/steer-gate.js";

test("steer gate flushes accepted work and rejects work after the final seal", async () => {
  const gate = new SteerGate();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let completed = false;
  const accepted = gate.submit(async () => { await blocked; completed = true; });
  assert.ok(accepted);
  const sealed = gate.seal();
  assert.equal(gate.submit(async () => {}), undefined);
  release();
  await Promise.all([accepted, sealed]);
  assert.equal(completed, true);
});
