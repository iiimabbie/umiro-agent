import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  } finally { await rm(root, { recursive: true, force: true }); }
});
