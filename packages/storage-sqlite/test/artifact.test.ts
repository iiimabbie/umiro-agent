import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SQLiteExecutionStore } from "../src/index.js";

test("artifact metadata persists workspace location without workspace-entry state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "umiro-artifact-")); const filename = join(dir, "db.sqlite"); const location = join(dir, "workspace", "attachments", "note.txt");
  const artifact = { id: "a1", ownerPrincipalId: "owner", visibility: "shared" as const, mediaType: "text/plain", filename: "note.txt", size: 3, sha256: "a".repeat(64), location, extractedText: "durable attachment text", parentSource: { kind: "discord_message", id: "m1" }, state: "stored" as const, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" };
  const store = new SQLiteExecutionStore(filename); await store.createArtifact({ artifact }); await store.updateArtifactLocation({ artifactId: artifact.id, location: `${location}.moved`, filename: "moved.txt", size: 3, sha256: artifact.sha256, updatedAt: "later" }); assert.equal((await store.getArtifact("a1"))?.location, `${location}.moved`); assert.equal((await store.getArtifact("a1"))?.filename, "moved.txt");
  store.close(); rmSync(dir, { recursive: true, force: true });
});
