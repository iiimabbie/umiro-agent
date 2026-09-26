import assert from "node:assert/strict";
import test from "node:test";
import { hostedWebSearchPolicy } from "../src/web-search-policy.js";

test("hosted web search has a dedicated timeout longer than the generic tool timeout", () => {
  assert.equal(hostedWebSearchPolicy.timeoutMs, 120_000);
  assert.ok(hostedWebSearchPolicy.timeoutMs > 30_000);
});
