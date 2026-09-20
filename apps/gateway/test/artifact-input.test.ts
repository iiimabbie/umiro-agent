import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "@umiro/core";
import { artifactModelContent } from "../src/artifact-input.js";

test("inbound images, text and unsupported files remain visible to the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-input-"));
  const image = join(root, "image"); const note = join(root, "note"); const pdf = join(root, "pdf");
  await writeFile(image, Buffer.from([1, 2, 3])); await writeFile(note, "hello attachment"); await writeFile(pdf, "pdf");
  const artifact = (id: string, mediaType: string, location: string, filename: string, extractedText?: string): Artifact => ({ id, ownerPrincipalId: "p", visibility: "shared", mediaType, filename, size: 3, sha256: id, location, ...(extractedText !== undefined ? { extractedText } : {}), state: "stored", createdAt: "now", updatedAt: "now" });
  try {
    assert.deepEqual(await artifactModelContent("inspect", [artifact("i", "image/png", image, "shot.png"), artifact("t", "text/plain", note, "note.txt"), artifact("p", "application/pdf", pdf, "doc.pdf")]), [
      { type: "text", text: "inspect" },
      { type: "image", url: "data:image/png;base64,AQID", detail: "auto" },
      { type: "text", text: "Attached file note.txt:\nhello attachment" },
      { type: "text", text: "Attached PDF: doc.pdf" },
      { type: "file", filename: "doc.pdf", data: "data:application/pdf;base64,cGRm" },
    ]);
    assert.deepEqual(await artifactModelContent("", [artifact("i", "image/png", image, "shot.png")], false), [{ type: "text", text: "Attached file: shot.png (image/png, 3 bytes)" }]);
    assert.deepEqual(await artifactModelContent("", [artifact("j", "application/json; charset=utf-8", note, "data.json", "{\"saved\":true}")]), [{ type: "text", text: "Attached file data.json:\n{\"saved\":true}" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PDF uses a Responses file part while Office and Chat profiles use extracted text", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-file-input-")); const pdf = join(root, "doc.pdf"); await writeFile(pdf, Buffer.from([1, 2, 3]));
  const artifact: Artifact = { id: "pdf", ownerPrincipalId: "p", visibility: "shared", mediaType: "application/pdf", filename: "doc.pdf", size: 3, sha256: "pdf", location: pdf, extractedText: "PDF extracted fallback", state: "stored", createdAt: "now", updatedAt: "now" };
  try {
    assert.deepEqual(await artifactModelContent("", [artifact], true, "openai_responses"), [{ type: "text", text: "Attached PDF: doc.pdf" }, { type: "file", filename: "doc.pdf", data: "data:application/pdf;base64,AQID" }]);
    assert.deepEqual(await artifactModelContent("", [{ ...artifact, id: "docx", filename: "doc.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }], true, "openai_responses"), [{ type: "text", text: "Attached file doc.docx:\nPDF extracted fallback" }]);
    assert.deepEqual(await artifactModelContent("", [artifact], true, "openai_chat_completions"), [{ type: "text", text: "Attached file doc.pdf:\nPDF extracted fallback" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("model image input uses the transient rendition while retaining the original artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-rendition-"));
  const original = join(root, "original"); await writeFile(original, Buffer.from([1, 2, 3, 4]));
  const artifact: Artifact = { id: "image", ownerPrincipalId: "p", visibility: "shared", mediaType: "image/jpeg", filename: "photo.jpg", size: 4, sha256: "image", location: original, state: "stored", createdAt: "now", updatedAt: "now" };
  const previousFetch = globalThis.fetch;
  let fetchedUrl = "";
  globalThis.fetch = async input => { fetchedUrl = String(input); return new Response(new Uint8Array([9, 8]), { status: 200, headers: { "content-type": "image/jpeg" } }); };
  try {
    const content = await artifactModelContent("inspect", [artifact], true, "openai_responses", [{ artifactId: "image", url: "https://media.discordapp.net/attachments/1/2/photo.jpg?ex=sig&width=576&height=768" }]);
    assert.equal(fetchedUrl, "https://media.discordapp.net/attachments/1/2/photo.jpg?ex=sig&width=576&height=768");
    assert.deepEqual(content, [{ type: "text", text: "inspect" }, { type: "image", url: "data:image/jpeg;base64,CQg=", detail: "auto" }]);
    assert.deepEqual([...await readFile(original)], [1, 2, 3, 4]);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("a failed transient rendition does not fall back to the original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-rendition-fail-"));
  const original = join(root, "original"); await writeFile(original, Buffer.from([1, 2, 3, 4]));
  const artifact: Artifact = { id: "image", ownerPrincipalId: "p", visibility: "shared", mediaType: "image/jpeg", filename: "photo.jpg", size: 4, sha256: "image", location: original, state: "stored", createdAt: "now", updatedAt: "now" };
  const previousFetch = globalThis.fetch; globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const content = await artifactModelContent("inspect", [artifact], true, "openai_responses", [{ artifactId: "image", url: "https://media.discordapp.net/attachments/1/2/photo.jpg?width=576&height=768" }]);
    assert.deepEqual(content, [{ type: "text", text: "inspect" }, { type: "text", text: "Attached image photo.jpg could not be loaded for vision input." }]);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("model image input uses the rendition response media type", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-rendition-type-"));
  const original = join(root, "original"); await writeFile(original, Buffer.from([1, 2, 3, 4]));
  const artifact: Artifact = { id: "image", ownerPrincipalId: "p", visibility: "shared", mediaType: "image/jpeg", filename: "photo.jpg", size: 4, sha256: "image", location: original, state: "stored", createdAt: "now", updatedAt: "now" };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([9, 8]), { status: 200, headers: { "content-type": "image/webp" } });
  try {
    const content = await artifactModelContent("", [artifact], true, "openai_responses", [{ artifactId: "image", url: "https://media.discordapp.net/attachments/1/2/photo.jpg?width=576&height=768" }]);
    assert.deepEqual(content, [{ type: "image", url: "data:image/webp;base64,CQg=", detail: "auto" }]);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});
