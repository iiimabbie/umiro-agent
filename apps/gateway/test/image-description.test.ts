import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact, ModelPort } from "@umiro/core";
import { describeImageArtifacts } from "../src/image-description.js";

test("vision descriptions are bounded and only produced for image artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-image-description-"));
  const imagePath = join(root, "image.bin"); await writeFile(imagePath, new Uint8Array([1, 2, 3]));
  const image: Artifact = { id: "image", ownerPrincipalId: "owner", visibility: "shared", mediaType: "image/webp", filename: "image.webp", size: 3, sha256: "a".repeat(64), location: imagePath, state: "stored", createdAt: "now", updatedAt: "now" };
  const text: Artifact = { ...image, id: "text", mediaType: "text/plain", filename: "note.txt" };
  let calls = 0;
  const model: ModelPort = { async generate(request) { calls++; assert.equal(request.model, "vision-model"); return { text: "A room with a map and a desk.", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, assistantMessage: { role: "assistant", content: "A room with a map and a desk." } }; } };
  try {
    const result = await describeImageArtifacts(model, "vision-model", [image, text]);
    assert.deepEqual(result.map(item => item.artifactId), ["image"]);
    assert.equal(result[0]?.description, "A room with a map and a desk."); assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
