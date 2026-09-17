import assert from "node:assert/strict";
import test from "node:test";
import { extractDiscordMessageText } from "../src/message-text.js";

test("extracts forwarded message snapshots when the outer message is empty", () => {
  const content = extractDiscordMessageText({
    content: "",
    messageSnapshots: {
      values: () => [{
        content: "轉發正文",
        embeds: [{ toJSON: () => ({ author: { name: "作者" }, title: "標題", description: "說明", fields: [{ name: "欄位", value: "內容" }], footer: { text: "頁尾" } }) }],
        components: [{ toJSON: () => ({ type: 17, components: [{ type: 10, content: "元件文字" }] }) }],
      }],
    },
  });

  assert.equal(content, "轉發正文\n作者\n標題\n說明\n欄位\n內容\n頁尾\n元件文字");
});

test("preserves visible text order across the message and its snapshots", () => {
  const content = extractDiscordMessageText({
    content: "外層",
    embeds: [{ toJSON: () => ({ title: "外層嵌入" }) }],
    messageSnapshots: { values: () => [{ content: "轉發一" }, { content: "轉發二" }] },
  });

  assert.equal(content, "外層\n外層嵌入\n轉發一\n轉發二");
});
