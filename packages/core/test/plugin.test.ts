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

test("skill contributions are manifest-bound and cannot reference missing tools", async () => {
  const module: PluginModule = {
    manifest: { schemaVersion: 0, id: "skill-plugin", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "skill-plugin", permissions: authority, contributes: { skills: ["skill-plugin.workflow"] } },
    create: () => ({ contributions: { skills: [{ id: "skill-plugin.workflow", description: "workflow", instructions: "Use the declared tool.", requiredTools: [] }] } }),
  };
  const host = new PluginHost(new ToolRegistry(), new ContextProviderRegistry(), authority);
  await host.enable(module);
  assert.equal(host.listSkills()[0]?.id, "skill-plugin.workflow");
  await host.disable("skill-plugin");
  assert.deepEqual(host.listSkills(), []);
});

test("skill activation fails closed when a required tool is unavailable", async () => {
  const module: PluginModule = {
    manifest: { schemaVersion: 0, id: "broken-skill", version: "1.0.0", coreApi: "0", entry: "./index.js", namespace: "broken-skill", permissions: authority, contributes: { skills: ["broken.workflow"] } },
    create: () => ({ contributions: { skills: [{ id: "broken.workflow", description: "broken", instructions: "", requiredTools: ["missing"] }] } }),
  };
  const host = new PluginHost(new ToolRegistry(), new ContextProviderRegistry(), authority);
  await assert.rejects(host.enable(module), /unavailable tool/);
  assert.equal(host.get("broken-skill")?.state, "failed");
});
