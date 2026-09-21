import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "@umiro/core";
import { artifactModelContent } from "../src/artifact-input.js";

const artifact = (id: string, mediaType: string, filename: string): Artifact => ({ id, ownerPrincipalId: "p", visibility: "shared", mediaType, filename, size: 4, sha256: "a".repeat(64), location: "/outside/untrusted/blob", state: "stored", createdAt: "now", updatedAt: "now" });
const bytes = async (input: Artifact) => ({ artifact: { ...input, filename: "renamed.pdf" }, bytes: new Uint8Array([1, 2, 3, 4]) });

test("uses the workspace resolver for native file input", async () => {
  const content = await artifactModelContent("inspect", [artifact("doc", "application/pdf", "doc.pdf")], true, "openai_responses", [], undefined, bytes);
  assert.deepEqual(content, [{ type: "text", text: "inspect" }, { type: "text", text: "Attached file: renamed.pdf" }, { type: "file", filename: "renamed.pdf", data: "data:application/pdf;base64,AQIDBA==" }]);
});

test("uses bounded workspace bytes for image input", async () => {
  const content = await artifactModelContent("inspect", [artifact("image", "image/png", "image.png")], true, "openai_responses", [], undefined, bytes);
  assert.equal(content[1]?.type, "image"); assert.match((content[1] as { url: string }).url, /^data:image\/png;base64,AQIDBA==/);
});

test("never falls back to artifact location when resolver is absent", async () => {
  await assert.rejects(artifactModelContent("inspect", [artifact("image", "image/png", "image.png")]), /workspace artifact resolver is unavailable/);
});
