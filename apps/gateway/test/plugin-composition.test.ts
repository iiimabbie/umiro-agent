import assert from "node:assert/strict";
import test from "node:test";
import type { PluginModule } from "@umiro/core/plugin";
import { orderPluginEnableEntries, pluginSecretsFromEnvironment } from "../src/plugin-composition.js";

function plugin(id: string, tools: readonly string[] = [], requiredTools: readonly string[] = []): PluginModule {
  return {
    manifest: {
      schemaVersion: 0,
      id,
      version: "0.0.0",
      coreApi: "0",
      entry: "./index.js",
      namespace: id,
      permissions: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" },
      contributes: {
        ...(tools.length ? { tools } : {}),
        ...(requiredTools.length ? { subagentProfiles: [{ id, description: `${id} profile`, instructions: ["Do the task."], requiredTools, authorityScope: { capabilities: [], instructionAuthority: "none" }, outputContract: { kind: "text" } }] } : {}),
      },
    },
    async create() { return { contributions: {} }; },
  };
}

test("plugin enable order places tool providers before consuming profiles", () => {
  const entries = [
    { configured: "coder", module: plugin("coder", [], ["read_file", "bash"]) },
    { configured: "people", module: plugin("people", ["people_add"]) },
    { configured: "host-tools", module: plugin("host-tools", ["read_file", "bash"]) },
  ];
  assert.deepEqual(orderPluginEnableEntries(entries).map(entry => entry.configured), ["people", "host-tools", "coder"]);
});

test("plugin enable order rejects cyclic tool dependencies", () => {
  const entries = [
    { configured: "a", module: plugin("a", ["tool_a"], ["tool_b"]) },
    { configured: "b", module: plugin("b", ["tool_b"], ["tool_a"]) },
  ];
  assert.throws(() => orderPluginEnableEntries(entries), /cyclic plugin tool dependencies: a, b/);
});

test("plugin secret injection includes only declared non-blank environment values", () => {
  const module = plugin("secret-user");
  const manifest = { ...module.manifest, requiredSecrets: ["OWNER_ID"], optionalSecrets: ["OPTIONAL_KEY"] };
  assert.deepEqual(pluginSecretsFromEnvironment(manifest, { OWNER_ID: "123", OPTIONAL_KEY: "  ", UNDECLARED: "hidden" }), { OWNER_ID: "123" });
  assert.deepEqual(pluginSecretsFromEnvironment(manifest, { OWNER_ID: "123", OPTIONAL_KEY: "available", UNDECLARED: "hidden" }), { OWNER_ID: "123", OPTIONAL_KEY: "available" });
});
