import assert from "node:assert/strict";
import test from "node:test";
import { parsePeople } from "../src/index.js";

test("parses PEOPLE sections and Discord identities", () => {
  const people = parsePeople("# PEOPLE\n\n## 小明\n- Discord ID: 123\n- 別名: Ming／阿明\n\n朋友");
  assert.equal(people[0]?.heading, "小明");
  assert.equal(people[0]?.discordId, "123");
  assert.deepEqual(people[0]?.aliases, ["小明", "Ming", "阿明"]);
});
