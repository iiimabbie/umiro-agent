import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteExecutionStore } from "../src/index.js";

test("plugin state is namespace isolated, versioned, and compare-and-swap safe", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const alpha = store.pluginState("alpha");
  const beta = store.pluginState("beta");
  try {
    await alpha.writeAtomic("buttons/one.json", new TextEncoder().encode("one"));
    assert.equal(new TextDecoder().decode(await alpha.read("buttons/one.json")), "one");
    assert.equal(await beta.read("buttons/one.json"), undefined);

    const first = await alpha.readVersioned("buttons/one.json");
    assert.equal(first?.version, 1);
    assert.deepEqual(await alpha.compareAndSwap("buttons/one.json", 99, new TextEncoder().encode("stale")), { updated: false });
    assert.deepEqual(await alpha.compareAndSwap("buttons/one.json", 1, new TextEncoder().encode("two")), { updated: true, version: 2 });
    assert.equal(new TextDecoder().decode(await alpha.read("buttons/one.json")), "two");
  } finally { store.close(); }
});

test("plugin state expiry is enforced on reads, lists, and cleanup", async () => {
  const store = new SQLiteExecutionStore(":memory:");
  const state = store.pluginState("expiring");
  try {
    await state.writeAtomic("old.json", new Uint8Array([1]), { expiresAt: "2020-01-01T00:00:00.000Z" });
    await state.writeAtomic("future.json", new Uint8Array([1, 2]), { expiresAt: "2999-01-01T00:00:00.000Z" });
    assert.equal(await state.read("old.json"), undefined);
    assert.deepEqual((await state.list()).map(entry => [entry.key, entry.size, entry.version]), [["future.json", 2, 1]]);
    assert.equal(await state.deleteExpired("3000-01-01T00:00:00.000Z"), 1);
    assert.equal((await state.list()).length, 0);
  } finally { store.close(); }
});
