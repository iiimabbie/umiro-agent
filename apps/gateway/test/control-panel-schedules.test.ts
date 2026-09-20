import assert from "node:assert/strict";
import test from "node:test";
import { classifySchedule, toControlPanelScheduleView } from "../src/control-panel-schedules.js";
import type { JsonObject, ScheduledTrigger } from "@umiro/core";

const trigger = (jobRef: string, input: JsonObject = {}): ScheduledTrigger => ({
  id: `trigger:${jobRef}`,
  revision: 0,
  name: "test",
  enabled: true,
  schedule: { kind: "cron", expression: "0 8 * * *" },
  timezone: "UTC",
  jobRef,
  input,
  creatorPrincipalId: "owner",
  creatorRoles: ["owner"],
  authority: { capabilities: [], visibility: { kind: "all" }, instructionAuthority: "none" },
  misfirePolicy: "coalesce",
  maxAttempts: 3,
  retryBackoffMs: 15_000,
  nextFireAt: "2026-09-22T08:00:00.000Z",
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
});

test("schedule ownership classification is single-source and fail-closed", () => {
  assert.deepEqual(classifySchedule(trigger("agent.prompt")), { kind: "user" });
  assert.deepEqual(classifySchedule(trigger("agent.prompt", { pluginId: "diary", model: "journal" })), { kind: "plugin", pluginId: "diary" });
  assert.deepEqual(classifySchedule(trigger("agent.prompt", { pluginId: "" })), { kind: "plugin", pluginId: "unknown-plugin" });
  assert.deepEqual(classifySchedule(trigger("agent.prompt", { pluginId: false })), { kind: "plugin", pluginId: "unknown-plugin" });
  assert.deepEqual(classifySchedule(trigger("plugin:guardian.check"), new Map([["guardian.check", "guardian"]])), { kind: "plugin", pluginId: "guardian" });
  assert.deepEqual(classifySchedule(trigger("plugin:unknown.check")), { kind: "plugin", pluginId: "unknown.check" });
  assert.deepEqual(classifySchedule(trigger("system:conversation-auto-archive")), { kind: "system", systemId: "conversation-auto-archive" });
  assert.deepEqual(classifySchedule(trigger("core:unknown")), { kind: "system", systemId: "core:unknown" });
});

test("managed schedule views omit raw managed input and expose only settings action", () => {
  const plugin = toControlPanelScheduleView(trigger("agent.prompt", { pluginId: "diary", model: "journal", prompt: "secret managed prompt" }));
  assert.deepEqual(plugin.owner, { kind: "plugin", pluginId: "diary" });
  assert.deepEqual(plugin.actions, { canToggle: false, canEdit: false, canDelete: false, settingsTarget: "plugin" });
  assert.equal("prompt" in plugin, false);
  assert.equal("input" in plugin, false);
  const system = toControlPanelScheduleView(trigger("system:conversation-auto-archive"));
  assert.deepEqual(system.actions, { canToggle: false, canEdit: false, canDelete: false, settingsTarget: "conversation" });
  const user = toControlPanelScheduleView(trigger("agent.prompt", { prompt: "user prompt" }));
  assert.equal(user.prompt, "user prompt");
  assert.deepEqual(user.actions, { canToggle: true, canEdit: true, canDelete: true });
});
