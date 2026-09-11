import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationEmojiCatalog } from "../src/emoji.js";

test("Application Emoji markup resolves outside code and remains stable when prepared twice", () => {
  const catalog = new ApplicationEmojiCatalog();
  catalog.replace([{ name: "party", id: "123456789012345678", animated: false }, { name: "dance", id: "223456789012345678", animated: true }]);
  const input = ":party: `:party:` :missing:\n```txt\n:dance:\n```\n:dance:";
  const expected = "<:party:123456789012345678> `:party:` :missing:\n```txt\n:dance:\n```\n<a:dance:223456789012345678>";
  assert.equal(catalog.resolveText(input), expected);
  assert.equal(catalog.resolveText(expected), expected);
  assert.equal(catalog.resolveReaction(":party:"), "123456789012345678");
  assert.equal(catalog.resolveReaction(":missing:"), ":missing:");
});

test("Application Emoji catalog rejects malformed records and sorts names", () => {
  const catalog = new ApplicationEmojiCatalog();
  catalog.replace([{ name: "z_ok", id: "2", animated: false }, { name: "a_ok", id: "1", animated: true }, { name: "bad-name", id: "3", animated: false }, { name: "okay", id: "not-id", animated: false }]);
  assert.deepEqual(catalog.list(), [{ name: "a_ok", id: "1", animated: true }, { name: "z_ok", id: "2", animated: false }]);
});
