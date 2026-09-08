import assert from "node:assert/strict";
import test from "node:test";
import {
  authorize,
  capabilities,
  deriveAuthority,
  intersectAuthority,
  isAuthoritySubset,
  type Authority,
  type ExecutionContext,
  type Principal,
} from "../src/index.js";

const owner: Principal = { id: "owner", kind: "human", roles: ["owner"] };
const member: Principal = { id: "member-1", kind: "human", roles: ["member"] };

function authority(values: readonly string[] = ["conversation.reply", "memory.read"]): Authority {
  return {
    capabilities: capabilities(...values),
    visibility: {
      kind: "restricted",
      principalIds: ["member-1"],
      labels: ["public"],
      resources: [{ kind: "artifact", id: "shared-report" }],
    },
    instructionAuthority: "scoped",
  };
}

function context(actor: Principal, origin: ExecutionContext["origin"], value = authority()): ExecutionContext {
  return { actor, origin, authority: value };
}

test("authorization is fail-closed and sensitive resources require visibility", () => {
  const memberContext = context(member, { kind: "interactive", transport: "discord", conversationId: "c1" });
  assert.equal(authorize({ context: memberContext, capability: "memory.write", tier: "common" }).reason, "capability_not_granted");
  assert.equal(authorize({ context: memberContext, capability: "memory.read", tier: "sensitive" }).reason, "resource_required");
  assert.equal(authorize({
    context: memberContext,
    capability: "memory.read",
    tier: "sensitive",
    resource: { kind: "memory", id: "mine", ownerPrincipalId: "member-1" },
  }).allow, true);
  assert.equal(authorize({
    context: memberContext,
    capability: "memory.read",
    tier: "sensitive",
    resource: { kind: "memory", id: "owner", ownerPrincipalId: "owner" },
  }).reason, "resource_outside_visibility");
});

test("privileged operations require an owner but permit bounded automation", () => {
  const privileged = authority(["shell.execute"]);
  assert.equal(authorize({
    context: context(member, { kind: "interactive", transport: "discord", conversationId: "c1" }, privileged),
    capability: "shell.execute",
    tier: "privileged",
  }).reason, "owner_required");
  assert.equal(authorize({
    context: context(owner, { kind: "schedule", scheduleId: "schedule-1" }, privileged),
    capability: "shell.execute",
    tier: "privileged",
  }).allow, true);
  assert.equal(authorize({
    context: context(owner, { kind: "schedule", scheduleId: "schedule-1" }, privileged),
    capability: "shell.execute",
    tier: "privileged",
    interactionRequirement: "interactive_required",
  }).reason, "interactive_origin_required");
  assert.equal(authorize({
    context: context(owner, { kind: "interactive", transport: "discord", conversationId: "c1" }, privileged),
    capability: "shell.execute",
    tier: "privileged",
  }).allow, true);
});

test("derived and intersected authority can only narrow", () => {
  const parent: Authority = {
    capabilities: capabilities("memory.read", "memory.write", "shell.execute"),
    visibility: { kind: "restricted", principalIds: ["owner", "member-1"], labels: ["public", "private"], resources: [] },
    instructionAuthority: "full",
  };
  const child = deriveAuthority(parent, {
    capabilities: capabilities("memory.read", "external.mutate"),
    visibility: { kind: "all" },
    instructionAuthority: "full",
  });
  assert.deepEqual([...child.capabilities], ["memory.read"]);
  assert.deepEqual(child.visibility, parent.visibility);
  assert.equal(isAuthoritySubset(child, parent), true);

  const current = authority(["memory.read", "conversation.reply"]);
  const effective = intersectAuthority(child, current);
  assert.deepEqual([...effective.capabilities], ["memory.read"]);
  assert.equal(effective.instructionAuthority, "scoped");
  assert.equal(isAuthoritySubset(effective, child), true);
  assert.equal(isAuthoritySubset(effective, current), true);
});

test("authority snapshots retain capabilities when serialized", () => {
  const snapshot = JSON.parse(JSON.stringify(authority())) as { capabilities: string[] };
  assert.deepEqual(snapshot.capabilities, ["conversation.reply", "memory.read"]);
});
