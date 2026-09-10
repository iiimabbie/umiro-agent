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

test("Artifact service backfills durable text for artifacts created by older releases", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-backfill-"));
  const location = join(root, "legacy.txt");
  await writeFile(location, "legacy searchable attachment");
  const artifact = { id: "legacy", ownerPrincipalId: "owner", visibility: "shared" as const, mediaType: "text/plain; charset=utf-8", filename: "legacy.txt", size: 28, sha256: "a".repeat(64), location, state: "stored" as const, createdAt: "old", updatedAt: "old" };
  const rows = new Map<string, Artifact>([[artifact.id, artifact]]);
  const service = new ArtifactFileService(root, {
    async createArtifact({ artifact: created }) { rows.set(created.id, created); },
    async getArtifact(id) { return rows.get(id); },
    async listArtifacts() { return [...rows.values()]; },
    async updateArtifactState() {}, async deleteArtifact() {}, canAccessArtifact() { return true; },
    async updateArtifactExtractedText(id, text, updatedAt) { rows.set(id, { ...rows.get(id)!, extractedText: text, updatedAt }); },
  }, undefined, () => "new");
  try {
    assert.deepEqual(await service.backfillTextExtractions(), { updated: 1, failed: 0 });
    assert.equal(rows.get("legacy")?.extractedText, "legacy searchable attachment");
    rows.set("missing", { ...artifact, id: "missing", location: join(root, "missing.txt") });
    assert.deepEqual(await service.backfillTextExtractions(), { updated: 0, failed: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
