import assert from "node:assert/strict";
import test from "node:test";
import { boundedDiscordImageUrl } from "../src/discord-image.js";

test("bounds a Discord image proportionally and preserves its signature", () => {
  assert.equal(
    boundedDiscordImageUrl("https://cdn.discordapp.com/attachments/1/2/photo.jpg?ex=abc&is=def&hm=ghi", 2160, 2880),
    "https://media.discordapp.net/attachments/1/2/photo.jpg?ex=abc&is=def&hm=ghi&width=576&height=768",
  );
});

test("leaves small, non-Discord, and invalid-dimension URLs unchanged", () => {
  const small = "https://cdn.discordapp.com/photo.jpg?ex=abc";
  assert.equal(boundedDiscordImageUrl(small, 768, 500), small);
  assert.equal(boundedDiscordImageUrl("https://example.test/photo.jpg", 2160, 2880), "https://example.test/photo.jpg");
  assert.equal(boundedDiscordImageUrl(small, 0, 2880), small);
  assert.equal(boundedDiscordImageUrl(small, Number.NaN, 2880), small);
});
