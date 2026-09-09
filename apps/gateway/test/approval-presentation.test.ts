import assert from "node:assert/strict";
import test from "node:test";
import { approvalDetails } from "../src/approval-presentation.js";

test("approval presentation redacts secrets and bounds arbitrary operation input", () => {
  const details = approvalDetails({ input: { path: "/tmp/a", apiKey: "hidden", nested: { password: "hidden-too" }, content: "x".repeat(2_000) } }, 300);
  assert.match(details, /"apiKey": "\[REDACTED\]"/);
  assert.match(details, /truncated/);
  assert.doesNotMatch(details, /hidden/);
  assert.ok(details.length < 340);
});
