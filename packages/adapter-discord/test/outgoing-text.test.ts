import assert from "node:assert/strict";
import test from "node:test";
import { DiscordJsAdapter } from "../src/client.js";
import { suppressDiscordLinkEmbeds } from "../src/outgoing-text.js";

test("wraps bare Discord URLs without changing their query, fragment, or punctuation", () => {
  assert.equal(
    suppressDiscordLinkEmbeds("文件：https://example.com/a_(b)?x=1&y=2#part。備用 https://example.org/test!"),
    "文件：<https://example.com/a_(b)?x=1&y=2#part>。備用 <https://example.org/test>!",
  );
});

test("preserves angle-bracket URLs, Markdown links, and Markdown images", () => {
  const input = "<https://example.com> [官網](https://example.org/path) ![圖](https://example.net/image.png)";
  assert.equal(suppressDiscordLinkEmbeds(input), "<https://example.com> [官網](<https://example.org/path>) ![圖](<https://example.net/image.png>)");
});

test("preserves URLs in inline and fenced code", () => {
  const input = "`https://inline.example`\n```txt\nhttps://fenced.example\n```\nhttps://outside.example";
  const expected = "`https://inline.example`\n```txt\nhttps://fenced.example\n```\n<https://outside.example>";
  assert.equal(suppressDiscordLinkEmbeds(input), expected);
});

test("URL suppression is stable when applied repeatedly", () => {
  const once = suppressDiscordLinkEmbeds("https://one.example https://two.example/path?q=yes");
  assert.equal(once, "<https://one.example> <https://two.example/path?q=yes>");
  assert.equal(suppressDiscordLinkEmbeds(once), once);
});

test("Discord central outgoing preparation suppresses link previews", () => {
  const adapter = new DiscordJsAdapter();
  assert.equal(adapter.prepareText("回覆 https://example.com/page"), "回覆 <https://example.com/page>");
});
