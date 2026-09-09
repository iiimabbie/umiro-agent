import assert from "node:assert/strict";
import test from "node:test";
import { ContextProviderRegistry } from "../src/context/index.js";
import { PluginHost, type PluginModule } from "../src/plugin/index.js";
import { ToolRegistry } from "../src/tool/index.js";

const authority = { capabilities: [], visibility: { kind: "all" as const }, instructionAuthority: "full" as const };

test("one plugin entry composes hooks, jobs and commands and removes them on disable", async () => {
  const calls: string[] = [];
  const module: PluginModule = {
    manifest: { schemaVersion: 0, id: "large-plugin", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "large-plugin", permissions: authority, contributes: { hooks: ["large.hook"], jobs: ["large.job"], commands: ["large"] } },
    create: () => ({ contributions: {
      hooks: [{ id: "large.hook", event: "run.completed", async handle() { calls.push("hook"); } }],
      jobs: [{ id: "large.job", schedule: "0 8 * * *", async run() { calls.push("job"); } }],
      commands: [{ name: "large", description: "large", async execute() { calls.push("command"); return {}; } }],
    } }),
  };
  const host = new PluginHost(new ToolRegistry(), new ContextProviderRegistry(), authority);
  await host.enable(module);
  await host.emitHook("run.completed", {});
  await host.runJob("large.job");
  await host.executeCommand("large", {});
  assert.deepEqual(calls, ["hook", "job", "command"]);
  await host.disable("large-plugin");
  assert.deepEqual(host.listJobs(), []);
  assert.deepEqual(host.listCommands(), []);
});
