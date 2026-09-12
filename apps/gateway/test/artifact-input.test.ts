import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
