import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SQLiteExecutionStore } from "../src/index.js";

test("artifacts persist metadata and lifecycle across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "umiro-artifact-"));
  const filename = join(dir, "db.sqlite");
  const artifact = { id: "a1", ownerPrincipalId: "owner", visibility: "shared" as const, mediaType: "text/plain", filename: "note.txt", size: 3, sha256: "a".repeat(64), location: join(dir, "aa"), extractedText: "durable attachment text", parentSource: { kind: "discord_message", id: "m1" }, state: "stored" as const, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" };
  const store = new SQLiteExecutionStore(filename);
  await store.createArtifact({ artifact });
  assert.deepEqual(await store.getArtifact("a1"), artifact);
  assert.equal(store.canAccessArtifact(artifact, "member", "shared"), true);
  await store.deleteArtifact("a1", "2026-09-09T00:01:00.000Z");
  store.close();
  const reopened = new SQLiteExecutionStore(filename);
  assert.equal((await reopened.getArtifact("a1"))?.state, "deleted");
  assert.equal((await reopened.listArtifacts()).length, 0);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("artifact workspace renames update the visible path and artifact filename atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "umiro-artifact-workspace-"));
  const filename = join(dir, "db.sqlite");
  const store = new SQLiteExecutionStore(filename);
  const artifact = { id: "mapped", ownerPrincipalId: "owner", visibility: "shared" as const, mediaType: "image/jpeg", filename: "old.jpg", size: 3, sha256: "b".repeat(64), location: join(dir, "blob"), state: "stored" as const, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" };
  await store.createArtifactWithWorkspaceEntry({ artifact, workspaceEntry: { artifactId: artifact.id, relativePath: "attachments/inbox/discord/m1/old.jpg", originalFilename: "old.jpg", state: "missing", device: "1", inode: "2", materializedSha256: artifact.sha256, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt } });
  await store.updateArtifactWorkspaceLocation({ artifactId: artifact.id, relativePath: "attachments/inbox/discord/m1/new.jpg", filename: "new.jpg", device: "1", inode: "2", updatedAt: "2026-09-20T00:01:00.000Z" });
  assert.equal((await store.getArtifact(artifact.id))?.filename, "new.jpg");
  assert.deepEqual(await store.getArtifactWorkspaceEntry(artifact.id), { artifactId: artifact.id, relativePath: "attachments/inbox/discord/m1/new.jpg", originalFilename: "old.jpg", state: "active", device: "1", inode: "2", materializedSha256: artifact.sha256, createdAt: artifact.createdAt, updatedAt: "2026-09-20T00:01:00.000Z" });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
