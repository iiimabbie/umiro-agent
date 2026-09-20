import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Artifact, ArtifactStore, PrincipalId } from "@umiro/core";
import { extractArtifactTextAsync } from "./artifact-text.js";

export interface IncomingAttachment {
  readonly url: string;
  readonly filename: string;
  readonly size: number;
  readonly mediaType?: string;
  readonly width?: number;
  readonly height?: number;
}

export class ArtifactFileService {
  constructor(private readonly root: string, private readonly store: ArtifactStore, private readonly maxBytes = 25 * 1024 * 1024, private readonly now = () => new Date().toISOString(), private readonly workspaceRoot?: string) {}

  async listBySource(source: { readonly kind: string; readonly id: string }): Promise<readonly Artifact[]> {
    return (await this.store.listArtifacts()).filter(artifact => artifact.parentSource?.kind === source.kind && artifact.parentSource.id === source.id);
  }

  async read(input: { readonly artifactId: string; readonly principalId: PrincipalId }): Promise<{ readonly bytes: Uint8Array; readonly filename?: string; readonly mediaType: string } | undefined> {
    const artifact = await this.store.getArtifact(input.artifactId);
    if (!artifact || !this.store.canAccessArtifact(artifact, input.principalId, artifact.visibility)) return undefined;
    try {
      const bytes = new Uint8Array(await readFile(artifact.location));
      return { bytes, ...(artifact.filename ? { filename: artifact.filename } : {}), mediaType: artifact.mediaType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async importDiscord(attachment: IncomingAttachment, ownerPrincipalId: PrincipalId, sourceMessageId: string): Promise<Artifact> {
    const url = new URL(attachment.url);
    if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) throw new Error("untrusted Discord attachment URL");
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > this.maxBytes) throw new Error(`attachment exceeds ${this.maxBytes} byte limit`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`attachment download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxBytes) throw new Error(`attachment exceeds ${this.maxBytes} byte limit`);
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
    const mediaType = response.headers.get("content-type") ?? attachment.mediaType ?? "application/octet-stream";
    const extractedText = await extractArtifactTextAsync(mediaType, bytes);
    const artifact: Artifact = { id, ownerPrincipalId, visibility: "shared", mediaType, filename: safeFilename(attachment.filename, id), size: bytes.byteLength, sha256, location, ...(extractedText !== undefined ? { extractedText } : {}), parentSource: { kind: "discord_message", id: sourceMessageId }, state: "stored", createdAt: at, updatedAt: at };
    await this.persistWithWorkspace(artifact, bytes, this.workspaceRoot ? join("attachments", "inbox", "discord", safeSegment(sourceMessageId), artifact.filename ?? `attachment-${id.slice(0, 8)}`) : undefined);
    return artifact;
  }

  async createFromFile(input: { readonly sourcePath: string; readonly ownerPrincipalId: PrincipalId; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string } }): Promise<Artifact> {
    return this.createFromWorkspaceFile(input);
  }

  async createFromWorkspaceFile(input: { readonly sourcePath: string; readonly ownerPrincipalId: PrincipalId; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string } }): Promise<Artifact> {
    if (!this.workspaceRoot) throw new Error("workspace attachments are unavailable");
    const source = await this.safeWorkspaceAttachment(input.sourcePath);
    const bytes = new Uint8Array(await readFile(source));
    // The source is already the human-visible workspace file. Import only an
    // immutable delivery blob; materializing it again would create a spurious
    // "(2)" copy and a second owner for the same visible path.
    return this.createFromBytes({ ...input, bytes });
  }

  async createFromBytes(input: { readonly bytes: Uint8Array; readonly ownerPrincipalId: PrincipalId; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string }; readonly workspaceRelativePath?: string }): Promise<Artifact> {
    const bytes = input.bytes;
    if (bytes.byteLength > this.maxBytes) throw new Error(`artifact exceeds ${this.maxBytes} byte limit`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const directory = join(this.root, sha256.slice(0, 2)); const location = join(directory, sha256);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID(); const temporary = `${location}.${id}.tmp`;
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" }); await rename(temporary, location).catch(async error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await rm(temporary, { force: true }); }); } catch (error) { await rm(temporary, { force: true }); throw error; }
    const at = this.now(); const mediaType = input.mediaType ?? "application/octet-stream"; const extractedText = await extractArtifactTextAsync(mediaType, bytes); const artifact: Artifact = { id, ownerPrincipalId: input.ownerPrincipalId, visibility: "shared", mediaType, ...(input.filename ? { filename: safeFilename(input.filename, id) } : {}), size: bytes.byteLength, sha256, location, ...(extractedText !== undefined ? { extractedText } : {}), ...(input.parentSource ? { parentSource: input.parentSource } : {}), state: "stored", createdAt: at, updatedAt: at };
    await this.persistWithWorkspace(artifact, bytes, input.workspaceRelativePath);
    return artifact;
  }

  private async safeWorkspaceAttachment(sourcePath: string): Promise<string> {
    if (!this.workspaceRoot) throw new Error("workspace attachments are unavailable");
    const { workspace, attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot);
    const requested = resolve(workspace, sourcePath);
    await assertNoSymlink(requested, attachmentsRoot);
    const source = await realpath(requested);
    const relativePath = relative(attachmentsRoot, source);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || resolve(attachmentsRoot, relativePath) !== source) throw new Error("file must be inside workspace attachments");
    await assertNoSymlink(source, attachmentsRoot);
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error("attachment must be a regular file");
    return source;
  }

  private async persistWithWorkspace(artifact: Artifact, bytes: Uint8Array, workspaceRelativePath?: string): Promise<void> {
    if (!workspaceRelativePath || !this.workspaceRoot) {
      await this.store.createArtifact({ artifact });
      return;
    }
    const { workspace, attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot);
    const target = resolve(workspace, workspaceRelativePath);
    const targetRel = relative(attachmentsRoot, target);
    if (!targetRel || targetRel === ".." || targetRel.startsWith(`..${sep}`)) throw new Error("workspace attachment path escapes attachments root");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const finalTarget = await writeWorkspaceFileExclusive(target, bytes, artifact.id);
    const relativePath = relative(workspace, finalTarget);
    try {
      const metadata = await stat(finalTarget);
      const entry = { artifactId: artifact.id, relativePath, originalFilename: artifact.filename ?? `attachment-${artifact.id.slice(0, 8)}`, state: "active" as const, device: String(metadata.dev), inode: String(metadata.ino), materializedSha256: artifact.sha256, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt };
      try { await this.store.createArtifactWithWorkspaceEntry({ artifact, workspaceEntry: entry }); }
      catch (error) { await rm(finalTarget, { force: true }); throw error; }
    } catch (error) { await rm(finalTarget, { force: true }); throw error; }
  }

  async moveWorkspaceFile(input: { readonly sourcePath: string; readonly destinationPath: string }): Promise<{ readonly oldPath: string; readonly newPath: string; readonly artifactId?: string; readonly databaseUpdated: boolean }> {
    if (!this.workspaceRoot) throw new Error("workspace attachment management is unavailable");
    const { workspace, attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot);
    const source = await this.safeUnder(attachmentsRoot, stripAttachmentsPrefix(input.sourcePath));
    const destination = await this.safeUnder(attachmentsRoot, stripAttachmentsPrefix(input.destinationPath), false);
    const sourceRelative = relative(workspace, source);
    const destinationRelative = relative(workspace, destination);
    const entry = await this.store.getArtifactWorkspaceEntryByPath(sourceRelative);
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error("source must be a regular file");
    try { await stat(destination); throw new Error("destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(source, destination);
    try {
      if (entry) {
        const nextStat = await stat(destination);
        await this.store.updateArtifactWorkspaceLocation({ artifactId: entry.artifactId, relativePath: destinationRelative, filename: basename(destination), device: String(nextStat.dev), inode: String(nextStat.ino), updatedAt: this.now() });
        return { oldPath: sourceRelative, newPath: destinationRelative, artifactId: entry.artifactId, databaseUpdated: true };
      }
      return { oldPath: sourceRelative, newPath: destinationRelative, databaseUpdated: false };
    } catch (error) {
      try { await rename(destination, source); } catch { if (entry && this.store.updateArtifactWorkspaceState) await this.store.updateArtifactWorkspaceState(entry.artifactId, "missing", this.now()); }
      throw error;
    }
  }

  async reconcileWorkspace(): Promise<{ readonly updated: number; readonly modified: number; readonly missing: number }> {
    if (!this.workspaceRoot) return { updated: 0, modified: 0, missing: 0 };
    const { workspace, attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot);
    const entries = await this.store.listArtifactWorkspaceEntries();
    const files = await this.scanFiles(attachmentsRoot);
    const byIdentity = new Map<string, string[]>();
    for (const file of files) { const s = await stat(file); const key = `${s.dev}:${s.ino}`; byIdentity.set(key, [...(byIdentity.get(key) ?? []), file]); }
    let updated = 0, modified = 0, missing = 0;
    for (const entry of entries) {
      if (entry.state === "trashed") continue;
      const expected = resolve(workspace, entry.relativePath);
      if (!insidePath(attachmentsRoot, expected)) {
        await this.store.updateArtifactWorkspaceState(entry.artifactId, "missing", this.now());
        missing++;
        continue;
      }
      try {
        await assertNoSymlink(expected, attachmentsRoot);
        const metadata = await lstat(expected);
        if (!metadata.isFile()) throw Object.assign(new Error("workspace attachment is not a regular file"), { code: "ENOENT" });
        const hash = await hashFile(expected);
        if (hash !== entry.materializedSha256) { await this.store.updateArtifactWorkspaceState(entry.artifactId, "modified", this.now()); modified++; continue; }
        if (entry.state !== "active") await this.store.updateArtifactWorkspaceState(entry.artifactId, "active", this.now());
        continue;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const candidates = files.filter(file => {
        const identity = byIdentity.get(`${entry.device}:${entry.inode}`) ?? [];
        return identity.includes(file);
      });
      const hashed: string[] = [];
      for (const candidate of candidates) if (await hashFile(candidate) === entry.materializedSha256) hashed.push(candidate);
      if (hashed.length === 1) {
        const candidate = hashed[0]!; const s = await stat(candidate);
        await this.store.updateArtifactWorkspaceLocation({ artifactId: entry.artifactId, relativePath: relative(workspace, candidate), filename: basename(candidate), device: String(s.dev), inode: String(s.ino), updatedAt: this.now() });
        updated++;
      } else { await this.store.updateArtifactWorkspaceState(entry.artifactId, "missing", this.now()); missing++; }
    }
    return { updated, modified, missing };
  }

  async getWorkspaceRelativePath(artifactId: string): Promise<string | undefined> {
    return (await this.store.getArtifactWorkspaceEntry(artifactId))?.relativePath;
  }

  private async safeUnder(root: string, requested: string, existing = true): Promise<string> {
    const candidate = resolve(root, requested);
    const rel = relative(root, candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("path must be inside workspace attachments");
    if (!existing) { await assertNoSymlink(dirname(candidate), root); return candidate; }
    await assertNoSymlink(candidate, root);
    const result = await realpath(candidate);
    const resultRel = relative(root, result);
    if (!resultRel || resultRel === ".." || resultRel.startsWith(`..${sep}`)) throw new Error("path must be inside workspace attachments");
    return result;
  }

  private async scanFiles(root: string): Promise<string[]> {
    const result: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await visit(path);
        else if (item.isFile()) result.push(path);
      }
    };
    await visit(root).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    return result;
  }

}

async function writeWorkspaceFileExclusive(target: string, bytes: Uint8Array, id: string): Promise<string> {
  const extension = extensionOf(basename(target));
  const stem = basename(target, extension);
  const temporary = join(dirname(target), `.${basename(target)}.${id}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
  try {
    for (let index = 1; ; index++) {
      const candidate = index === 1 ? target : join(dirname(target), `${stem} (${index})${extension}`);
      try {
        await copyFile(temporary, candidate, fsConstants.COPYFILE_EXCL);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function extensionOf(filename: string): string {
  const extension = basename(filename).match(/\.[A-Za-z0-9]{1,16}$/)?.[0] ?? "";
  return extension;
}

function safeFilename(filename: string, id: string): string {
  const cleaned = basename(filename).replace(/[\\/\0\x00-\x1f\x7f]/g, "").trim().replace(/[. ]+$/g, "").slice(0, 120);
  return cleaned || `attachment-${id.slice(0, 8)}`;
}

function safeSegment(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown"; }
function stripAttachmentsPrefix(value: string): string { return value === "attachments" ? "" : value.startsWith(`attachments${sep}`) ? value.slice(`attachments${sep}`.length) : value; }

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertNoSymlink(path: string, root: string): Promise<void> {
  let current = path;
  while (insidePath(root, current)) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error("symlink paths are not allowed for workspace attachments");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function insidePath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function safeWorkspaceRoots(workspaceRoot: string): Promise<{ workspace: string; attachmentsRoot: string }> {
  const workspace = await realpath(workspaceRoot);
  const configuredAttachments = join(workspace, "attachments");
  const metadata = await lstat(configuredAttachments);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("workspace attachments root must be a regular directory");
  const attachmentsRoot = await realpath(configuredAttachments);
  if (!insidePath(workspace, attachmentsRoot)) throw new Error("workspace attachments root escapes the workspace");
  return { workspace, attachmentsRoot };
}
