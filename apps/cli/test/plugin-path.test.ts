import assert from "node:assert/strict";
import test from "node:test";
import { managedPluginPath } from "../src/plugin-path.js";

test("managed plugin path rejects traversal and remains below its root", () => {
  assert.equal(managedPluginPath("/plugins", "umiro-plugins", "daily-report"), "/plugins/umiro-plugins-daily-report");
  for (const unsafe of ["..", ".", "../outside", "a/b", "a\\b"]) assert.throws(() => managedPluginPath("/plugins", "repo", unsafe));
  assert.throws(() => managedPluginPath("/plugins", ".."));
});
