import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact, ArtifactStore } from "@umiro/core";
import { ArtifactFileService } from "../src/artifact-files.js";

function store(rows: Map<string, Artifact>): ArtifactStore {
  return { async createArtifact({ artifact }) { rows.set(artifact.id, artifact); }, async getArtifact(id) { return rows.get(id); }, async listArtifacts() { return [...rows.values()]; }, async updateArtifactState() {}, async updateArtifactLocation(input) { const current = rows.get(input.artifactId); if (current) rows.set(input.artifactId, { ...current, location: input.location, ...(input.filename ? { filename: input.filename } : {}), size: input.size, sha256: input.sha256, updatedAt: input.updatedAt }); }, async deleteArtifact() {}, canAccessArtifact() { return true; } };
}

test("stores bytes only in workspace attachments and resolves metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "umiro-workspace-artifact-")); const rows = new Map<string, Artifact>(); const service = new ArtifactFileService(workspace, store(rows));
  try { const artifact = await service.createFromBytes({ bytes: new TextEncoder().encode("hello"), ownerPrincipalId: "owner", filename: "result.txt", mediaType: "text/plain" }); assert.match(artifact.location, /workspace-artifact-.*attachments[\\/]generated[\\/]result\.txt$/); assert.equal(await readFile(artifact.location, "utf8"), "hello"); assert.equal(artifact.extractedText, "hello"); assert.equal(await service.getWorkspaceRelativePath(artifact.id), "attachments/generated/result.txt"); }
  finally { await rm(workspace, { recursive: true, force: true }); }
});

test("relocates an artifact by hash after a normal filesystem move", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "umiro-workspace-relocate-")); await mkdir(join(workspace, "attachments"), { recursive: true }); const rows = new Map<string, Artifact>(); const service = new ArtifactFileService(workspace, store(rows));
  try { const artifact = await service.createFromBytes({ bytes: new Uint8Array([1, 2, 3]), ownerPrincipalId: "owner", filename: "photo.png", mediaType: "image/png", workspaceRelativePath: "attachments/photo.png" }); await rename(join(workspace, "attachments/photo.png"), join(workspace, "attachments/renamed.png")); const resolved = await service.resolveArtifactFile(artifact); assert.equal(resolved.path, join(workspace, "attachments/renamed.png")); assert.equal(resolved.artifact.filename, "renamed.png"); assert.equal(rows.get(artifact.id)?.location, resolved.path); assert.equal(rows.get(artifact.id)?.filename, "renamed.png"); }
  finally { await rm(workspace, { recursive: true, force: true }); }
});

test("rejects symlinks and paths outside attachments", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "umiro-workspace-safe-")); const outside = await mkdtemp(join(tmpdir(), "umiro-outside-")); await mkdir(join(workspace, "attachments"), { recursive: true }); await writeFile(join(outside, "private.png"), new Uint8Array([1])); await symlink(join(outside, "private.png"), join(workspace, "attachments/private.png")); const service = new ArtifactFileService(workspace, store(new Map()));
  try { await assert.rejects(service.resolveWorkspaceFileForModel({ sourcePath: "attachments/private.png", ownerPrincipalId: "owner" }), /symlink/); await assert.rejects(service.resolveWorkspaceFileForModel({ sourcePath: join("..", "outside", "private.png"), ownerPrincipalId: "owner" }), /inside workspace attachments/); }
  finally { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("moves workspace files without database coupling", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "umiro-workspace-move-")); await mkdir(join(workspace, "attachments"), { recursive: true }); await writeFile(join(workspace, "attachments/a.txt"), "a"); const service = new ArtifactFileService(workspace, store(new Map()));
  try { assert.deepEqual(await service.moveWorkspaceFile({ sourcePath: "attachments/a.txt", destinationPath: "attachments/b.txt" }), { oldPath: "attachments/a.txt", newPath: "attachments/b.txt" }); assert.equal(await readFile(join(workspace, "attachments/b.txt"), "utf8"), "a"); }
  finally { await rm(workspace, { recursive: true, force: true }); }
});

test("rejects a move destination outside attachments before changing the source", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "umiro-workspace-move-safe-")); await mkdir(join(workspace, "attachments"), { recursive: true }); await writeFile(join(workspace, "attachments/a.txt"), "a"); const service = new ArtifactFileService(workspace, store(new Map()));
  try { await assert.rejects(service.moveWorkspaceFile({ sourcePath: "attachments/a.txt", destinationPath: ".trash/a.txt" }), /inside workspace attachments/); assert.equal(await readFile(join(workspace, "attachments/a.txt"), "utf8"), "a"); }
  finally { await rm(workspace, { recursive: true, force: true }); }
});

test("writes repeated identical bytes at each requested workspace target", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "umiro-workspace-single-copy-")); const rows = new Map<string, Artifact>(); const service = new ArtifactFileService(workspace, store(rows));
  try { const first = await service.createFromBytes({ bytes: new Uint8Array([9, 8]), ownerPrincipalId: "owner", filename: "one.bin", workspaceRelativePath: "attachments/one.bin" }); const second = await service.createFromBytes({ bytes: new Uint8Array([9, 8]), ownerPrincipalId: "owner", filename: "two.bin", workspaceRelativePath: "attachments/two.bin" }); assert.notEqual(first.location, second.location); assert.equal(await service.getWorkspaceRelativePath(second.id), "attachments/two.bin"); }
  finally { await rm(workspace, { recursive: true, force: true }); }
});
