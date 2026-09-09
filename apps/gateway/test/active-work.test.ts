import assert from "node:assert/strict";
import test from "node:test";
import { ActiveWorkTracker } from "../src/active-work.js";

test("active work drains without cancellation when callbacks finish", async () => {
  const tracker = new ActiveWorkTracker();
  tracker.track(Promise.resolve("done"));
  assert.deepEqual(await tracker.drain({ timeoutMs: 50, cancellationGraceMs: 50, cancel: () => { throw new Error("must not cancel"); } }), { drained: true, cancelled: 0 });
  assert.equal(tracker.size, 0);
});

test("active work is cancelled after the graceful deadline and then drained", async () => {
  const tracker = new ActiveWorkTracker();
  const controller = new AbortController();
  tracker.track(new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })));
  const result = await tracker.drain({ timeoutMs: 5, cancellationGraceMs: 50, cancel: () => { controller.abort(); return 1; } });
  assert.deepEqual(result, { drained: true, cancelled: 1 });
  assert.equal(tracker.size, 0);
});

test("active work reports a callback that ignores cancellation", async () => {
  const tracker = new ActiveWorkTracker();
  tracker.track(new Promise<void>(() => undefined));
  assert.deepEqual(await tracker.drain({ timeoutMs: 5, cancellationGraceMs: 5, cancel: () => 1 }), { drained: false, cancelled: 1 });
});
