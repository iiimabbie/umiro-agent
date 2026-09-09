import assert from "node:assert/strict";
import test from "node:test";
import { approvalCustomId, parseApprovalCustomId } from "../src/client.js";

test("approval button IDs round-trip only bounded safe identifiers", () => {
  const value = approvalCustomId("approve", "approval_123.test");
  assert.equal(value, "umiro:approval:approve:approval_123.test");
  assert.deepEqual(parseApprovalCustomId(value), { action: "approve", approvalId: "approval_123.test" });
  assert.deepEqual(parseApprovalCustomId("umiro:approval:deny:a"), { action: "deny", approvalId: "a" });
  assert.equal(parseApprovalCustomId("other:approve:a"), undefined);
  assert.throws(() => approvalCustomId("approve", "../escape"));
  assert.throws(() => approvalCustomId("approve", "x".repeat(65)));
});
