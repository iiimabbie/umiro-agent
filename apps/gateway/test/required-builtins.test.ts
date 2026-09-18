import assert from "node:assert/strict";
import test from "node:test";
import { assertRequiredBuiltins, REQUIRED_BUILTIN_PLUGIN_IDS, validateManagedPluginEntries, type ManagedPluginEntry } from "../src/required-builtins.js";

const entries = (): ManagedPluginEntry[] => REQUIRED_BUILTIN_PLUGIN_IDS.map(id => ({ source: `builtin:${id}`, path: `/plugins/${id}`, enabled: true }));

test("required built-in Agent capabilities must all remain enabled", () => {
  assert.doesNotThrow(() => assertRequiredBuiltins(entries()));
  for (const id of REQUIRED_BUILTIN_PLUGIN_IDS) {
    assert.throws(() => assertRequiredBuiltins(entries().map(entry => entry.source === `builtin:${id}` ? { ...entry, enabled: false } : entry)), new RegExp(id));
    assert.throws(() => assertRequiredBuiltins(entries().filter(entry => entry.source !== `builtin:${id}`)), new RegExp(id));
  }
});

test("managed Plugin configuration accepts only the current object format", () => {
  assert.deepEqual(validateManagedPluginEntries(entries()), entries());
  assert.throws(() => validateManagedPluginEntries(["/plugins/example"]), /invalid plugin entry/);
});
