import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Artifact, ArtifactStore, PrincipalId } from "@umiro/core";
import { extractArtifactText } from "./artifact-text.js";

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
    const mediaType = attachment.mediaType ?? response.headers.get("content-type") ?? "application/octet-stream";
    const extractedText = extractArtifactText(mediaType, bytes);
    const artifact: Artifact = { id, ownerPrincipalId, visibility: "shared", mediaType, filename: basename(attachment.filename), size: bytes.byteLength, sha256, location, ...(extractedText !== undefined ? { extractedText } : {}), parentSource: { kind: "discord_message", id: sourceMessageId }, state: "stored", createdAt: at, updatedAt: at };
    await this.store.createArtifact({ artifact });
    return artifact;
  }

  async createFromFile(input: { readonly sourcePath: string; readonly ownerPrincipalId: PrincipalId; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string } }): Promise<Artifact> {
    const source = await realpath(input.sourcePath);
    const root = await realpath(this.root);
    const rel = relative(root, source);
    if (rel === "" || rel.startsWith("..") || resolve(root, rel) !== source) throw new Error("artifact source must be inside the artifact staging directory");
    const bytes = new Uint8Array(await readFile(source));
    return this.createFromBytes({ ...input, bytes });
  }

  async createFromBytes(input: { readonly bytes: Uint8Array; readonly ownerPrincipalId: PrincipalId; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string } }): Promise<Artifact> {
    const bytes = input.bytes;
    if (bytes.byteLength > this.maxBytes) throw new Error(`artifact exceeds ${this.maxBytes} byte limit`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const directory = join(this.root, sha256.slice(0, 2)); const location = join(directory, sha256);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID(); const temporary = `${location}.${id}.tmp`;
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" }); await rename(temporary, location).catch(async error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await rm(temporary, { force: true }); }); } catch (error) { await rm(temporary, { force: true }); throw error; }
    const at = this.now(); const mediaType = input.mediaType ?? "application/octet-stream"; const extractedText = extractArtifactText(mediaType, bytes); const artifact: Artifact = { id, ownerPrincipalId: input.ownerPrincipalId, visibility: "shared", mediaType, ...(input.filename ? { filename: basename(input.filename) } : {}), size: bytes.byteLength, sha256, location, ...(extractedText !== undefined ? { extractedText } : {}), ...(input.parentSource ? { parentSource: input.parentSource } : {}), state: "stored", createdAt: at, updatedAt: at };
    await this.store.createArtifact({ artifact }); return artifact;
  }

  /** Backfills artifacts created before extracted text became durable metadata. */
  async backfillTextExtractions(): Promise<{ readonly updated: number; readonly failed: number }> {
    const updateExtraction = this.store.updateArtifactExtractedText?.bind(this.store);
    if (!updateExtraction) return { updated: 0, failed: 0 };
    let updated = 0; let failed = 0;
    for (const artifact of await this.store.listArtifacts()) {
      if (artifact.extractedText !== undefined) continue;
      const normalized = artifact.mediaType.toLowerCase().split(";", 1)[0]!.trim();
      if (!normalized.startsWith("text/") && normalized !== "application/json") continue;
      try {
        const text = extractArtifactText(artifact.mediaType, await readFile(artifact.location));
        if (text === undefined) continue;
        await updateExtraction(artifact.id, text, this.now());
        updated += 1;
      } catch { failed += 1; }
    }
    return { updated, failed };
  }
}
