import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_EXPLANATIONS, ControlPanelServer, validateControlConfig } from "../src/control-panel.js";

test("model capabilities are explicit and reject unknown values", () => {
  assert.deepEqual(validateControlConfig({ model: "gemma4", modelCapabilities: ["vision", "hosted_web_search"], contextMaxTokens: 24_000 }), { model: "gemma4", modelCapabilities: ["vision", "hosted_web_search"], contextMaxTokens: 24_000 });
  assert.throws(() => validateControlConfig({ model: "gemma4", modelCapabilities: ["web_search"] }), /modelCapabilities/);
  assert.throws(() => validateControlConfig({ model: "gemma4", contextMaxTokens: 0 }), /contextMaxTokens/);
  assert.deepEqual(validateControlConfig({ model: "gemma4", pricing: { gemma4: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 } } }), { model: "gemma4", pricing: { gemma4: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 } } });
  assert.throws(() => validateControlConfig({ model: "gemma4", pricing: { gemma4: { inputUsdPerMillion: -1, outputUsdPerMillion: 0 } } }), /pricing/);
  assert.throws(() => validateControlConfig({ model: "gemma4", embedding: { apiKey: "must-not-live-here" } }), /must use SecretSource/);
  assert.throws(() => validateControlConfig({ model: "gemma4", plugins: [{ path: "/plugin", config: { token: "secret" } }] }), /must use SecretSource/);
  assert.deepEqual(validateControlConfig({ model: "gemma4", authority: { member: { capabilities: ["memory.search"], visibility: { kind: "restricted", principalIds: [], labels: [], resources: [] } } } }).authority, { member: { capabilities: ["memory.search"], visibility: { kind: "restricted", principalIds: [], labels: [], resources: [] } } });
});

test("model profiles validate model, capability, and reasoning selection", () => {
  assert.deepEqual(validateControlConfig({ model: "gemma4", protocol: "openai_chat_completions", profiles: { fast: { model: "gemma4:9b", protocol: "openai_responses", capabilities: ["function_tools"], reasoningEffort: "low" } } }).profiles, { fast: { model: "gemma4:9b", protocol: "openai_responses", capabilities: ["function_tools"], reasoningEffort: "low" } });
  assert.throws(() => validateControlConfig({ model: "gemma4", profiles: { fast: { model: "gemma4", capabilities: ["unknown"] } } }), /profile fast\.capabilities/);
  assert.throws(() => validateControlConfig({ model: "gemma4", protocol: "ollama" }), /protocol/);
  assert.throws(() => validateControlConfig({ model: "gemma4", protocol: "openai_chat_completions", modelCapabilities: ["hosted_web_search"] }), /require openai_responses/);
  assert.throws(() => validateControlConfig({ model: "gemma4", profiles: { fast: { model: "gemma4", typo: true } } }), /unsupported field/);
});

test("every control-panel config option explains its default, risk, and restart behavior", () => {
  for (const explanation of Object.values(CONFIG_EXPLANATIONS)) {
    assert.ok("defaultValue" in explanation);
    assert.equal(typeof explanation.risk, "string");
    assert.ok(explanation.risk.length > 0);
    assert.equal(typeof explanation.restartRequired, "boolean");
  }
});

test("localhost control panel authenticates config and fixed workspace file operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-web-ui-")); const workspace = join(root, "workspace"); const configFile = join(root, "umiro.json");
  await mkdir(workspace); await writeFile(join(workspace, "AGENT.md"), "before\n"); await writeFile(configFile, `${JSON.stringify({ model: "gemma4", discord: {}, webUi: { enabled: true, host: "127.0.0.1", port: 3210 }, plugins: [] })}\n`);
  const schedules = [{ id: "schedule-1", name: "daily", enabled: true, schedule: { kind: "cron", expression: "0 8 * * *" } }]; let created: unknown; let enabled: unknown; let updatedSchedule: unknown; let removed: unknown;
  let pluginAction: unknown; let approvalAction: unknown; let runLimit: unknown; let runId: unknown; const audits: Array<{ event: string; data: Record<string, unknown> }> = [];
  const server = new ControlPanelServer({ host: "127.0.0.1", port: 0, token: "test-token", configFile, workspace, workspaceFiles: ["AGENT.md"], secrets: () => ({ DISCORD_TOKEN: true, LLM_API_KEY: false }), models: async () => ["gemma4", "gpt-5"], audit: (event, data) => audits.push({ event, data }), schedules: {
    async list() { return schedules; }, async create(input) { created = input; return { id: "new", ...input }; }, async setEnabled(id, value) { enabled = [id, value]; return { id, enabled: value }; }, async update(id, input) { updatedSchedule = [id, input]; return { id, ...input }; }, async remove(id) { removed = id; return true; },
  }, plugins: { async list() { return [{ source: "builtin:memory", enabled: true }]; }, async run(...args) { pluginAction = args; return { ok: true }; } }, approvals: { async list() { return [{ id: "approval-1", operation: "write", details: "{}", expiresAt: "later" }]; }, async resolve(...args) { approvalAction = args; return { approval: args[1] }; } }, runs: { async list(limit) { runLimit = limit; return [{ id: "run-1", state: "succeeded" }]; }, async get(id) { runId = id; return id === "run-1" ? { run: { id } } : undefined; } }, logs: limit => [{ event: "test", limit }], usage: () => ({ completedRuns: 2, inputTokens: 10, outputTokens: 5 }), runtime: () => ({ status: "running", bot: { tag: "dev" } }) }); await server.start();
  const endpoint = `http://127.0.0.1:${server.port()}`; const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${endpoint}/api/config`)).status, 401);
    const schema = await (await fetch(`${endpoint}/api/schema`, { headers })).json(); assert.deepEqual(schema, CONFIG_EXPLANATIONS);
    assert.deepEqual(await (await fetch(`${endpoint}/api/secrets`, { headers })).json(), { DISCORD_TOKEN: true, LLM_API_KEY: false });
    assert.deepEqual(await (await fetch(`${endpoint}/api/models`, { headers })).json(), ["gemma4", "gpt-5"]);
    assert.deepEqual(await (await fetch(`${endpoint}/api/workspace`, { headers })).json(), ["AGENT.md"]);
    const updated = { model: "new-model", discord: { allowedGuilds: ["g"] }, webUi: { enabled: true, host: "127.0.0.1", port: 4000 }, plugins: [] };
    assert.equal((await fetch(`${endpoint}/api/config`, { method: "PUT", headers, body: JSON.stringify(updated) })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), updated);
    assert.equal((await fetch(`${endpoint}/api/workspace/AGENT.md`, { method: "PUT", headers, body: JSON.stringify({ content: "after\n" }) })).status, 200);
    assert.equal(await readFile(join(workspace, "AGENT.md"), "utf8"), "after\n");
    assert.equal((await fetch(`${endpoint}/api/workspace/PEOPLE.md`, { headers })).status, 404);
    assert.equal((await fetch(`${endpoint}/api/workspace/SECRET.md`, { headers })).status, 404);
    assert.deepEqual(await (await fetch(`${endpoint}/api/schedules`, { headers })).json(), schedules);
    assert.equal((await fetch(`${endpoint}/api/schedules`, { method: "POST", headers, body: JSON.stringify({ name: "later", kind: "once", at: "2026-09-10T00:00:00.000Z", timezone: "Asia/Taipei", prompt: "提醒我" }) })).status, 201);
    assert.deepEqual(created, { name: "later", kind: "once", at: "2026-09-10T00:00:00.000Z", timezone: "Asia/Taipei", prompt: "提醒我" });
    assert.equal((await fetch(`${endpoint}/api/schedules/schedule-1`, { method: "PATCH", headers, body: JSON.stringify({ enabled: false }) })).status, 200); assert.deepEqual(enabled, ["schedule-1", false]);
    assert.equal((await fetch(`${endpoint}/api/schedules/schedule-1`, { method: "PATCH", headers, body: JSON.stringify({ name: "weekday", kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Taipei", prompt: "工作提醒" }) })).status, 200); assert.deepEqual(updatedSchedule, ["schedule-1", { name: "weekday", kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Taipei", prompt: "工作提醒" }]);
    assert.equal((await fetch(`${endpoint}/api/schedules/schedule-1`, { method: "DELETE", headers })).status, 200); assert.equal(removed, "schedule-1");
    assert.deepEqual(await (await fetch(`${endpoint}/api/plugins`, { headers })).json(), [{ source: "builtin:memory", enabled: true }]);
    assert.equal((await fetch(`${endpoint}/api/plugins/action`, { method: "POST", headers, body: JSON.stringify({ action: "configure", source: "builtin:memory", config: { limit: 10 } }) })).status, 200);
    assert.deepEqual(pluginAction, ["configure", "builtin:memory", undefined, { limit: 10 }]);
    assert.deepEqual(await (await fetch(`${endpoint}/api/runtime`, { headers })).json(), { status: "running", bot: { tag: "dev" } });
    assert.deepEqual(await (await fetch(`${endpoint}/api/runs?limit=30`, { headers })).json(), [{ id: "run-1", state: "succeeded" }]); assert.equal(runLimit, 30);
    assert.deepEqual(await (await fetch(`${endpoint}/api/runs/run-1`, { headers })).json(), { run: { id: "run-1" } }); assert.equal(runId, "run-1");
    assert.equal((await fetch(`${endpoint}/api/runs/missing`, { headers })).status, 404);
    assert.equal((await fetch(`${endpoint}/api/runs?limit=0`, { headers })).status, 400);
    assert.deepEqual(await (await fetch(`${endpoint}/api/logs?limit=25`, { headers })).json(), [{ event: "test", limit: 25 }]);
    assert.equal((await fetch(`${endpoint}/api/logs?limit=501`, { headers })).status, 400);
    assert.deepEqual(await (await fetch(`${endpoint}/api/usage`, { headers })).json(), { completedRuns: 2, inputTokens: 10, outputTokens: 5 });
    assert.equal((await fetch(`${endpoint}/api/approvals/approval-1`, { method: "POST", headers, body: JSON.stringify({ action: "approve" }) })).status, 200);
    assert.deepEqual(approvalAction, ["approval-1", "approve"]);
    assert.deepEqual(audits.map(item => item.event), ["control.config.saved", "control.workspace.saved", "control.schedule.created", "control.schedule.toggled", "control.schedule.updated", "control.schedule.removed", "control.plugin.action", "control.approval.resolved"]);
    assert.doesNotMatch(JSON.stringify(audits), /new-model|after|builtin:memory/);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});

test("control panel refuses public bind addresses", () => {
  assert.throws(() => new ControlPanelServer({ host: "0.0.0.0", port: 3210, token: "token", configFile: "/tmp/no", workspace: "/tmp" }), /loopback/);
});

test("health and readiness probes are public and report component state", async () => {
  const checks = { storage: true, plugins: true, discord: false, scheduler: false, shuttingDown: false };
  const server = new ControlPanelServer({ host: "127.0.0.1", port: 0, token: "secret", configFile: "/tmp/no", workspace: "/tmp", readiness: () => checks });
  await server.start();
  const endpoint = `http://127.0.0.1:${server.port()}`;
  try {
    const health = await fetch(`${endpoint}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "alive" });

    const unavailable = await fetch(`${endpoint}/readyz`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: "not_ready", pid: process.pid, checks });

    checks.discord = true; checks.scheduler = true;
    const ready = await fetch(`${endpoint}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready", pid: process.pid, checks });

    checks.shuttingDown = true;
    assert.equal((await fetch(`${endpoint}/readyz`)).status, 503);
  } finally { await server.stop(); }
});
