import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact, ArtifactStore, ArtifactWorkspaceEntry } from "@umiro/core";
import { ArtifactFileService } from "../src/artifact-files.js";

function testArtifactStore(rows: Map<string, Artifact>, entries = new Map<string, ArtifactWorkspaceEntry>(), overrides: Partial<ArtifactStore> = {}): ArtifactStore {
  return {
    async createArtifact({ artifact }) { rows.set(artifact.id, artifact); },
    async createArtifactWithWorkspaceEntry({ artifact, workspaceEntry }) { rows.set(artifact.id, artifact); entries.set(artifact.id, workspaceEntry); },
    async getArtifact(id) { return rows.get(id); },
    async listArtifacts() { return [...rows.values()]; },
    async updateArtifactState() {},
    async deleteArtifact() {},
    canAccessArtifact() { return true; },
    async getArtifactWorkspaceEntry(id) { return entries.get(id); },
    async getArtifactWorkspaceEntryByPath(path) { return [...entries.values()].find(entry => entry.relativePath === path); },
    async listArtifactWorkspaceEntries() { return [...entries.values()]; },
    async updateArtifactWorkspaceLocation(input) {
      const entry = entries.get(input.artifactId);
      if (entry) entries.set(input.artifactId, { ...entry, relativePath: input.relativePath, state: "active", ...(input.device !== undefined ? { device: input.device } : {}), ...(input.inode !== undefined ? { inode: input.inode } : {}), updatedAt: input.updatedAt });
      const artifact = rows.get(input.artifactId);
      if (artifact) rows.set(input.artifactId, { ...artifact, filename: input.filename, updatedAt: input.updatedAt });
    },
    async updateArtifactWorkspaceState(id, state, updatedAt) {
      const entry = entries.get(id);
      if (entry) entries.set(id, { ...entry, state, updatedAt });
    },
    ...overrides,
  };
}

test("Artifact service stores plugin-produced bytes with durable metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-plugin-"));
  const rows = new Map<string, Artifact>();
  const service = new ArtifactFileService(root, testArtifactStore(rows));
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
  const service = new ArtifactFileService(root, testArtifactStore(rows, new Map(), {
    canAccessArtifact(candidate, principalId, visibility) { return candidate.state !== "deleted" && visibility === candidate.visibility && (candidate.visibility !== "private" || candidate.ownerPrincipalId === principalId); },
  }));
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
  const service = new ArtifactFileService(root, testArtifactStore(rows));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" } });
  try {
    const artifact = await service.importDiscord({ url: "https://cdn.discordapp.com/converted", filename: "photo.png", size: 1, mediaType: "image/png" }, "owner", "message");
    assert.equal(artifact.size, 3);
    assert.equal(artifact.mediaType, "image/webp");
    assert.deepEqual([...await readFile(artifact.location)], [1, 2, 3]);
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});

test("office attachments receive durable text extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-office-"));
  const rows = new Map<string, Artifact>();
  const service = new ArtifactFileService(root, testArtifactStore(rows));
  try {
    const artifact = await service.createFromBytes({ bytes: new TextEncoder().encode("{\\rtf1\\ansi Searchable office text}"), ownerPrincipalId: "owner", filename: "note.rtf", mediaType: "application/rtf" });
    assert.match(artifact.extractedText ?? "", /Searchable office text/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Discord imports materialize a visible copy and managed moves update its mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-visible-"));
  const workspace = await mkdtemp(join(tmpdir(), "umiro-workspace-visible-"));
  await mkdir(join(workspace, "attachments"), { recursive: true });
  const rows = new Map<string, Artifact>();
  const entries = new Map<string, ArtifactWorkspaceEntry>();
  const store = testArtifactStore(rows, entries);
  const service = new ArtifactFileService(root, store, 25 * 1024 * 1024, () => "2026-09-20T00:00:00.000Z", workspace);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new TextEncoder().encode("visible"), { status: 200, headers: { "content-type": "text/plain" } });
  try {
    const artifact = await service.importDiscord({ url: "https://cdn.discordapp.com/file", filename: "photo.txt", size: 7 }, "owner", "123");
    assert.equal(await readFile(join(workspace, "attachments/inbox/discord/123/photo.txt"), "utf8"), "visible");
    assert.equal(entries.get(artifact.id)?.relativePath, "attachments/inbox/discord/123/photo.txt");
    const moved = await service.moveWorkspaceFile({ sourcePath: "attachments/inbox/discord/123/photo.txt", destinationPath: "attachments/inbox/discord/123/renamed.txt" });
    assert.equal(moved.databaseUpdated, true);
    assert.equal(rows.get(artifact.id)?.filename, "renamed.txt");
    assert.equal(entries.get(artifact.id)?.relativePath, "attachments/inbox/discord/123/renamed.txt");
    await rename(join(workspace, "attachments/inbox/discord/123/renamed.txt"), join(workspace, "attachments/inbox/discord/123/raw-move.txt"));
    assert.equal((await service.reconcileWorkspace()).updated, 1);
    assert.equal(rows.get(artifact.id)?.filename, "raw-move.txt");
    assert.equal(entries.get(artifact.id)?.relativePath, "attachments/inbox/discord/123/raw-move.txt");
  } finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});

test("importing an existing workspace attachment does not create a duplicate visible copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "umiro-artifact-outbound-"));
  const workspace = await mkdtemp(join(tmpdir(), "umiro-workspace-outbound-"));
  const source = join(workspace, "attachments/report.txt");
  await mkdir(join(workspace, "attachments"), { recursive: true });
  await writeFile(source, "report");
  const rows = new Map<string, Artifact>();
  const service = new ArtifactFileService(root, testArtifactStore(rows), 25 * 1024 * 1024, () => "2026-09-20T00:00:00.000Z", workspace);
  try {
    const artifact = await service.createFromWorkspaceFile({ sourcePath: source, ownerPrincipalId: "owner", filename: "report.txt", parentSource: { kind: "operation", id: "op" } });
    assert.equal(await readFile(source, "utf8"), "report");
    await assert.rejects(readFile(join(workspace, "attachments/report (2).txt"), "utf8"), /ENOENT/);
    assert.equal(rows.get(artifact.id)?.filename, "report.txt");
  } finally { await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); }
});
