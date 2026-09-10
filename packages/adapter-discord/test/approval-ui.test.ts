import assert from "node:assert/strict";
import test from "node:test";
import { approvalCustomId, parseApprovalCustomId, parseButtonCustomId } from "../src/client.js";

test("approval button IDs round-trip only bounded safe identifiers", () => {
  const value = approvalCustomId("approve", "approval_123.test");
  assert.equal(value, "umiro:approval:approve:approval_123.test");
  assert.deepEqual(parseApprovalCustomId(value), { action: "approve", approvalId: "approval_123.test" });
  assert.deepEqual(parseApprovalCustomId("umiro:approval:deny:a"), { action: "deny", approvalId: "a" });
  assert.equal(parseApprovalCustomId("other:approve:a"), undefined);
  assert.throws(() => approvalCustomId("approve", "../escape"));
  assert.throws(() => approvalCustomId("approve", "x".repeat(65)));
});

test("generic button IDs cannot be confused with approval IDs", () => {
  assert.deepEqual(parseButtonCustomId("umiro:button:550e8400-e29b-41d4-a716-446655440000:run_now"), { buttonSetId: "550e8400-e29b-41d4-a716-446655440000", buttonId: "run_now" });
  assert.equal(parseApprovalCustomId("umiro:button:550e8400-e29b-41d4-a716-446655440000:run_now"), undefined);
  assert.equal(parseButtonCustomId("umiro:approval:approve:a"), undefined);
  assert.equal(parseButtonCustomId("umiro:button:../escape:x"), undefined);
});
