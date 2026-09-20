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

test("vision descriptions use the transient Discord rendition instead of the original artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-image-description-rendition-"));
  const imagePath = join(root, "image.bin"); await writeFile(imagePath, new Uint8Array([1, 2, 3]));
  const image: Artifact = { id: "image", ownerPrincipalId: "owner", visibility: "shared", mediaType: "image/jpeg", filename: "image.jpg", size: 3, sha256: "a".repeat(64), location: imagePath, state: "stored", createdAt: "now", updatedAt: "now" };
  const previousFetch = globalThis.fetch;
  let fetchedUrl = "";
  globalThis.fetch = async input => { fetchedUrl = String(input); return new Response(new Uint8Array([9, 8]), { status: 200, headers: { "content-type": "image/webp" } }); };
  const model: ModelPort = { async generate(request) {
    assert.deepEqual(request.messages[0]?.content, [
      { type: "text", text: "Describe this image for future semantic search. State the visible subjects, setting, readable text, and notable details. Do not guess hidden facts. Return only the concise description." },
      { type: "image", url: "data:image/webp;base64,CQg=", detail: "auto" },
    ]);
    return { text: "A bounded image.", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 }, assistantMessage: { role: "assistant", content: "A bounded image." } };
  } };
  try {
    const url = "https://media.discordapp.net/attachments/1/2/image.jpg?width=576&height=768";
    await describeImageArtifacts(model, "vision-model", [image], undefined, undefined, [{ artifactId: image.id, url }]);
    assert.equal(fetchedUrl, url);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});
