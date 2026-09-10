import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeAuthorities, validateAuthorityConfig } from "../src/authority-config.js";

const available = [
  "filesystem.read", "scheduler.write", "web.fetch", "memory.search",
  "discord.message.read", "tool.catalog",
];

test("owner and member authorities have separate secure defaults", () => {
  const result = resolveRuntimeAuthorities(undefined, available, ["channel-1", "channel-1"]);
  assert.deepEqual(result.ownerAuthority, {
    capabilities: available,
    visibility: { kind: "all" },
    instructionAuthority: "full",
  });
  assert.deepEqual(result.memberAuthority, {
    capabilities: ["web.fetch", "scheduler.write", "memory.search", "discord.message.read", "tool.catalog"],
    visibility: {
      kind: "restricted",
      principalIds: [],
      labels: ["public-web"],
      resources: [{ kind: "discord-channel", id: "channel-1" }],
    },
    instructionAuthority: "scoped",
  });
  assert.notEqual(result.ownerAuthority, result.memberAuthority);
});

test("authority config is explicit, bounded by installed capabilities, and keeps members restricted", () => {
  const configured = { member: { capabilities: ["scheduler.write"], visibility: { kind: "restricted" as const, principalIds: ["member"], labels: [], resources: [] }, instructionAuthority: "none" as const } };
  validateAuthorityConfig(configured);
  assert.deepEqual(resolveRuntimeAuthorities(configured, available, []).memberAuthority, {
    capabilities: ["scheduler.write"],
    visibility: { kind: "restricted", principalIds: ["member"], labels: [], resources: [] },
    instructionAuthority: "none",
  });
  assert.throws(() => validateAuthorityConfig({ member: { visibility: { kind: "all" } } }), /must be restricted/);
  assert.throws(() => resolveRuntimeAuthorities({ owner: { capabilities: ["missing"] } }, available, []), /unavailable capability/);
});
