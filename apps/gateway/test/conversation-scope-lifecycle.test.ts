import assert from "node:assert/strict";
import test from "node:test";
import { ConversationScopeBusyError, ConversationScopeLifecycleCoordinator } from "../src/conversation-scope-lifecycle.js";

test("untrack is rejected while an active Run owns the scope", async () => {
  const coordinator = new ConversationScopeLifecycleCoordinator();
  let release!: () => void;
  const running = coordinator.run("channel", () => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(() => coordinator.untrack("channel", async () => undefined), (error: unknown) => error instanceof ConversationScopeBusyError && error.statusCode === 409);
  release();
  await running;
  let untracked = false;
  await coordinator.untrack("channel", async () => { untracked = true; });
  assert.equal(untracked, true);
});

test("scope operations serialize without blocking independent scopes", async () => {
  const coordinator = new ConversationScopeLifecycleCoordinator();
  const order: string[] = [];
  let release!: () => void;
  const first = coordinator.untrack("one", () => new Promise<void>(resolve => { order.push("one-start"); release = resolve; }));
  const second = coordinator.untrack("one", async () => { order.push("one-second"); });
  const other = coordinator.untrack("two", async () => { order.push("two"); });
  await other;
  assert.deepEqual(order, ["one-start", "two"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["one-start", "two", "one-second"]);
});
