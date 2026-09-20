import assert from "node:assert/strict";
import test from "node:test";
import { toDiscordAttachmentEnvelope } from "../src/index.js";

test("normalizes Discord attachment dimensions into the envelope", () => {
  assert.deepEqual(toDiscordAttachmentEnvelope({ id: "a", url: "https://cdn.discordapp.com/a", name: "photo.jpg", size: 10, contentType: "image/jpeg", width: 2160, height: 2880 }), {
    id: "a", url: "https://cdn.discordapp.com/a", filename: "photo.jpg", size: 10, mediaType: "image/jpeg", width: 2160, height: 2880,
  });
  assert.deepEqual(toDiscordAttachmentEnvelope({ id: "b", url: "https://cdn.discordapp.com/b", name: "unknown", size: 2, contentType: null, width: null, height: null }), {
    id: "b", url: "https://cdn.discordapp.com/b", filename: "unknown", size: 2,
  });
});
