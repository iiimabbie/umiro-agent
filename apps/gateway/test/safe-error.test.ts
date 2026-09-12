import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorMessage } from "../src/safe-error.js";

test("operational error messages are bounded and redact credentials", () => {
  assert.equal(safeErrorMessage(new Error("request abc123 https://example.test/?token=url-secret&x=1"), ["abc123"]), "request [REDACTED] https://example.test/?token=[REDACTED]&x=1");
  assert.equal(safeErrorMessage(new Error("x".repeat(600)), []).length, 500);
});
