import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Artifact, ArtifactStore, PrincipalId } from "@umiro/core";

export interface IncomingAttachment { readonly url: string; readonly filename: string; readonly size: number; readonly mediaType?: string }

export class ArtifactFileService {
  constructor(private readonly root: string, private readonly store: ArtifactStore, private readonly maxBytes = 25 * 1024 * 1024, private readonly now = () => new Date().toISOString()) {}

  async importDiscord(attachment: IncomingAttachment, ownerPrincipalId: PrincipalId, sourceMessageId: string): Promise<Artifact> {
    const url = new URL(attachment.url);
    if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) throw new Error("untrusted Discord attachment URL");
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > this.maxBytes) throw new Error(`attachment exceeds ${this.maxBytes} byte limit`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`attachment download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== attachment.size || bytes.byteLength > this.maxBytes) throw new Error("attachment size mismatch");
    const id = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const directory = join(this.root, sha256.slice(0, 2));
    const location = join(directory, sha256);
    const temporary = join(directory, `.${id}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try { await rename(temporary, location).catch(async error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await rm(temporary, { force: true }); }); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    const at = this.now();
    const artifact: Artifact = { id, ownerPrincipalId, visibility: "shared", mediaType: attachment.mediaType ?? response.headers.get("content-type") ?? "application/octet-stream", filename: basename(attachment.filename), size: bytes.byteLength, sha256, location, parentSource: { kind: "discord_message", id: sourceMessageId }, state: "stored", createdAt: at, updatedAt: at };
    await this.store.createArtifact({ artifact });
    return artifact;
  }
}
