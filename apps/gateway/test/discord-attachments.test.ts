import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "@umiro/core";
import { importDiscordAttachments } from "../src/discord-attachments.js";

const artifact = (id: string): Artifact => ({ id, ownerPrincipalId: "owner", visibility: "shared", mediaType: "image/webp", filename: `${id}.webp`, size: 1, sha256: "a".repeat(64), location: `/tmp/${id}`, state: "stored", createdAt: "now", updatedAt: "now" });

test("Discord attachment failures are isolated and represented in model context", async () => {
  const failures: string[] = [];
  const result = await importDiscordAttachments({
    async importDiscord(input) {
      if (input.filename === "bad.png") throw new Error("attachment download failed: HTTP 404");
      return artifact("good");
    },
  }, [
    { url: "https://cdn.discordapp.com/good", filename: "good.png", size: 1 },
    { url: "https://cdn.discordapp.com/bad", filename: "bad.png", size: 1 },
  ], "owner", "message", failure => failures.push(`${failure.filename}: ${failure.reason}`));

  assert.deepEqual(result.artifacts.map(item => item.id), ["good"]);
  assert.deepEqual(failures, ["bad.png: Discord download failed"]);
  assert.match(result.promptSuffix, /bad\.png: Discord download failed/);
});

test("successful Discord imports expose an ephemeral bounded rendition mapping", async () => {
  const result = await importDiscordAttachments({ async importDiscord() { return artifact("photo"); } }, [{ url: "https://cdn.discordapp.com/attachments/1/2/photo.jpg?ex=sig", filename: "photo.jpg", size: 1, mediaType: "image/jpeg", width: 2160, height: 2880 }], "owner", "message", () => {});
  assert.deepEqual(result.modelRenditions, [{ artifactId: "photo", url: "https://media.discordapp.net/attachments/1/2/photo.jpg?ex=sig&width=576&height=768" }]);
});
