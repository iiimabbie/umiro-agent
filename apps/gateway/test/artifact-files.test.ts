import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "@umiro/core";
import { ArtifactFileService } from "../src/artifact-files.js";

test("Artifact service stores plugin-produced bytes with durable metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-plugin-"));
  const rows = new Map<string, any>();
  const service = new ArtifactFileService(root, { async createArtifact({ artifact }) { rows.set(artifact.id, artifact); }, async getArtifact(id) { return rows.get(id); }, async listArtifacts() { return [...rows.values()]; }, async updateArtifactState() {}, async deleteArtifact() {}, canAccessArtifact() { return true; } });
  try {
    const artifact = await service.createFromBytes({ bytes: new TextEncoder().encode("plugin output"), ownerPrincipalId: "owner", filename: "result.txt", mediaType: "text/plain", parentSource: { kind: "tool", id: "op" } });
    assert.equal(await readFile(artifact.location, "utf8"), "plugin output");
    assert.deepEqual(rows.get(artifact.id), artifact);
    assert.equal(artifact.filename, "result.txt");
    assert.equal(artifact.extractedText, "plugin output");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Artifact service reads accessible bytes without revealing missing or inaccessible records", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-read-"));
  const location = join(root, "stored.txt");
  await writeFile(location, "attachment contents");
  const rows = new Map<string, Artifact>();
  const artifact: Artifact = { id: "stored", ownerPrincipalId: "owner", visibility: "shared", mediaType: "text/plain", filename: "stored.txt", size: 19, sha256: "a".repeat(64), location, state: "stored", createdAt: "now", updatedAt: "now" };
  rows.set(artifact.id, artifact);
  const service = new ArtifactFileService(root, {
    async createArtifact({ artifact: created }) { rows.set(created.id, created); },
    async getArtifact(id) { return rows.get(id); },
    async listArtifacts() { return [...rows.values()]; },
    async updateArtifactState() {}, async deleteArtifact() {},
    canAccessArtifact(candidate, principalId, visibility) { return candidate.state !== "deleted" && visibility === candidate.visibility && (candidate.visibility !== "private" || candidate.ownerPrincipalId === principalId); },
  });
  try {
    const accessible = await service.read({ artifactId: "stored", principalId: "member" });
    assert.equal(new TextDecoder().decode(accessible?.bytes), "attachment contents");
    assert.deepEqual(accessible && { ...accessible, bytes: [...accessible.bytes] }, { bytes: [...new TextEncoder().encode("attachment contents")], filename: "stored.txt", mediaType: "text/plain" });

    rows.set("private", { ...artifact, id: "private", visibility: "private" });
    rows.set("deleted", { ...artifact, id: "deleted", state: "deleted" });
    rows.set("lost", { ...artifact, id: "lost", location: join(root, "missing.txt") });
    assert.equal(await service.read({ artifactId: "private", principalId: "member" }), undefined);
    assert.equal(await service.read({ artifactId: "deleted", principalId: "owner" }), undefined);
    assert.equal(await service.read({ artifactId: "missing", principalId: "owner" }), undefined);
    assert.equal(await service.read({ artifactId: "lost", principalId: "owner" }), undefined);
    assert.equal(new TextDecoder().decode((await service.read({ artifactId: "private", principalId: "owner" }))?.bytes), "attachment contents");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Discord imports accept CDN-transformed sizes and use the returned media type", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-discord-"));
  const rows = new Map<string, Artifact>();
  const service = new ArtifactFileService(root, { async createArtifact({ artifact }) { rows.set(artifact.id, artifact); }, async getArtifact(id) { return rows.get(id); }, async listArtifacts() { return [...rows.values()]; }, async updateArtifactState() {}, async deleteArtifact() {}, canAccessArtifact() { return true; } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" } });
  try {
    const artifact = await service.importDiscord({ url: "https://cdn.discordapp.com/converted", filename: "photo.png", size: 1, mediaType: "image/png" }, "owner", "message");
    assert.equal(artifact.size, 3);
    assert.equal(artifact.mediaType, "image/webp");
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("office attachments receive durable text extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-office-"));
  const rows = new Map<string, Artifact>();
  const service = new ArtifactFileService(root, { async createArtifact({ artifact }) { rows.set(artifact.id, artifact); }, async getArtifact(id) { return rows.get(id); }, async listArtifacts() { return [...rows.values()]; }, async updateArtifactState() {}, async deleteArtifact() {}, canAccessArtifact() { return true; } });
  try {
    const artifact = await service.createFromBytes({ bytes: new TextEncoder().encode("{\\rtf1\\ansi Searchable office text}"), ownerPrincipalId: "owner", filename: "note.rtf", mediaType: "application/rtf" });
    assert.match(artifact.extractedText ?? "", /Searchable office text/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
