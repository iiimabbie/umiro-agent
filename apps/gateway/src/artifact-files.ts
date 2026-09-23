import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, realpath, rm, stat, lstat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Artifact, ArtifactStore, PrincipalId } from "@umiro/core";
import { extractArtifactTextAsync } from "./artifact-text.js";

export interface IncomingAttachment { readonly url: string; readonly filename: string; readonly size: number; readonly mediaType?: string; readonly width?: number; readonly height?: number }
export interface ResolvedWorkspaceArtifact { readonly artifact: Artifact; readonly path: string; readonly bytes: Uint8Array }
const MAX_MODEL_INPUT_BYTES = 20 * 1024 * 1024;

export function safeArtifactFilename(value: string | undefined, fallback: string): string {
  const name = basename(value?.replace(/[\\/\0\x00-\x1f\x7f]/g, "") ?? "").trim().replace(/[. ]+$/g, "");
  return name.slice(0, 120) || fallback;
}
function extensionOf(filename: string): string { return extname(filename).toLowerCase(); }
function inferWorkspaceMediaType(filename: string): string | undefined {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".tsv": "text/tsv", ".log": "text/plain", ".json": "application/json", ".html": "text/html", ".xml": "text/xml", ".rtf": "application/rtf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".odt": "application/vnd.oasis.opendocument.text" } as Record<string, string>)[extensionOf(filename)];
}
function hashBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
async function safeWorkspaceRoots(workspaceRoot: string): Promise<{ workspace: string; attachmentsRoot: string }> { const workspaceMetadata = await lstat(workspaceRoot); if (workspaceMetadata.isSymbolicLink() || !workspaceMetadata.isDirectory()) throw new Error("workspace must be a regular directory"); const workspace = await realpath(workspaceRoot); const attachmentsRoot = resolve(workspace, "attachments"); await mkdir(attachmentsRoot, { recursive: true, mode: 0o700 }); const attachmentsMetadata = await lstat(attachmentsRoot); if (attachmentsMetadata.isSymbolicLink() || !attachmentsMetadata.isDirectory()) throw new Error("workspace attachments must be a regular directory"); return { workspace, attachmentsRoot }; }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && rel !== ""; }
function insideOrRoot(root: string, path: string): boolean { return path === root || inside(root, path); }

async function assertNoSymlink(path: string, root: string): Promise<void> {
  const relativePath = relative(root, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) throw new Error("path must be inside workspace attachments");
  let current = root;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    const metadata = await lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (metadata?.isSymbolicLink()) throw new Error("symlink paths are not allowed for workspace attachments");
  }
}
async function safeExistingAttachment(path: string, attachmentsRoot: string): Promise<string> {
  const candidate = resolve(path);
  if (!inside(attachmentsRoot, candidate)) throw new Error("file must be inside workspace attachments");
  await assertNoSymlink(candidate, attachmentsRoot);
  const resolved = await realpath(candidate);
  if (!inside(attachmentsRoot, resolved)) throw new Error("file must be inside workspace attachments");
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error("attachment must be a regular file");
  return resolved;
}
async function writeWorkspaceFileExclusive(target: string, bytes: Uint8Array, token: string, attachmentsRoot: string): Promise<string> {
  const directory = dirname(target); await mkdir(directory, { recursive: true, mode: 0o700 }); await assertNoSymlink(directory, attachmentsRoot);
  const resolvedDirectory = await realpath(directory); if (!insideOrRoot(attachmentsRoot, resolvedDirectory)) throw new Error("workspace attachment path escapes attachments root");
  const base = basename(target); const suffix = extname(base); const stem = suffix ? base.slice(0, -suffix.length) : base;
  for (let index = 1; index < 10_000; index++) {
    const candidate = index === 1 ? target : join(directory, `${stem} (${index})${suffix}`); const temporary = join(directory, `.${token}-${index}.tmp`);
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" }); try { await link(temporary, candidate); await rm(temporary, { force: true }); return candidate; } catch (error) { await rm(temporary, { force: true }); if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    catch (error) { await rm(temporary, { force: true }); if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
  }
  throw new Error("unable to allocate a workspace attachment filename");
}

export class ArtifactFileService {
  constructor(private readonly workspaceRoot: string, private readonly store: ArtifactStore, private readonly maxBytes = 25 * 1024 * 1024, private readonly now = () => new Date().toISOString()) {}
  async listBySource(source: { readonly kind: string; readonly id: string }): Promise<readonly Artifact[]> { return (await this.store.listArtifacts()).filter(artifact => artifact.parentSource?.kind === source.kind && artifact.parentSource.id === source.id); }

  async read(input: { readonly artifactId: string; readonly principalId: PrincipalId }): Promise<{ readonly bytes: Uint8Array; readonly filename?: string; readonly mediaType: string } | undefined> {
    const artifact = await this.store.getArtifact(input.artifactId); if (!artifact || !this.store.canAccessArtifact(artifact, input.principalId, artifact.visibility)) return undefined;
    try { const resolved = await this.resolveArtifactFile(artifact); return { bytes: resolved.bytes, ...(resolved.artifact.filename ? { filename: resolved.artifact.filename } : {}), mediaType: resolved.artifact.mediaType }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "artifact bytes are unavailable") return undefined; throw error; }
  }

  async importDiscord(attachment: IncomingAttachment, ownerPrincipalId: string, sourceMessageId: string): Promise<Artifact> {
    const url = new URL(attachment.url); if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) throw new Error("untrusted Discord attachment URL");
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > this.maxBytes) throw new Error(`attachment exceeds ${this.maxBytes} byte limit`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(`attachment download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > this.maxBytes) throw new Error(`attachment exceeds ${this.maxBytes} byte limit`); const mediaType = response.headers.get("content-type") ?? attachment.mediaType;
    return this.createFromBytes({ bytes, ownerPrincipalId, filename: attachment.filename, ...(mediaType ? { mediaType } : {}), parentSource: { kind: "discord_message", id: sourceMessageId }, workspaceRelativePath: join("attachments", "inbox", safeArtifactFilename(attachment.filename, `attachment-${randomUUID().slice(0, 8)}`)) });
  }

  async createFromWorkspaceFile(input: { readonly sourcePath: string; readonly ownerPrincipalId: string; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string } }): Promise<Artifact> {
    const { workspace, attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot); const source = await safeExistingAttachment(this.inputPath(workspace, input.sourcePath), attachmentsRoot); const metadata = await stat(source); if (metadata.size > this.maxBytes) throw new Error(`artifact exceeds ${this.maxBytes} byte limit`); const bytes = new Uint8Array(await readFile(source));
    const mediaType = input.mediaType ?? inferWorkspaceMediaType(basename(source));
    return this.createArtifact({ bytes, ownerPrincipalId: input.ownerPrincipalId, filename: input.filename ?? basename(source), ...(mediaType ? { mediaType } : {}), ...(input.parentSource ? { parentSource: input.parentSource } : {}), location: source });
  }

  async resolveWorkspaceFileForModel(input: { readonly sourcePath: string; readonly ownerPrincipalId: string; readonly parentSource?: { readonly kind: string; readonly id: string } }): Promise<Artifact> {
    const { workspace, attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot); const source = await safeExistingAttachment(this.inputPath(workspace, input.sourcePath), attachmentsRoot); const metadata = await stat(source); if (metadata.size > Math.min(this.maxBytes, MAX_MODEL_INPUT_BYTES)) throw new Error("workspace attachment exceeds the model input size limit"); const bytes = new Uint8Array(await readFile(source));
    if (bytes.byteLength > Math.min(this.maxBytes, MAX_MODEL_INPUT_BYTES)) throw new Error("workspace attachment exceeds the model input size limit");
    const filename = basename(source); const mediaType = inferWorkspaceMediaType(filename); if (!mediaType) throw new Error(`unsupported workspace attachment type: ${extensionOf(filename) || "unknown"}`);
    const hash = hashBytes(bytes); const existing = (await this.store.listArtifacts()).find(artifact => artifact.state !== "deleted" && artifact.sha256 === hash && artifact.size === bytes.byteLength && this.store.canAccessArtifact(artifact, input.ownerPrincipalId, artifact.visibility));
    if (existing) { await this.store.updateArtifactLocation?.({ artifactId: existing.id, location: source, filename, size: bytes.byteLength, sha256: hash, updatedAt: this.now() }); return { ...existing, location: source, filename, size: bytes.byteLength, sha256: hash, updatedAt: this.now() }; }
    return this.createArtifact({ bytes, ownerPrincipalId: input.ownerPrincipalId, filename, mediaType, ...(input.parentSource ? { parentSource: input.parentSource } : {}), location: source });
  }

  async createFromBytes(input: { readonly bytes: Uint8Array; readonly ownerPrincipalId: PrincipalId; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string }; readonly workspaceRelativePath?: string }): Promise<Artifact> {
    if (input.bytes.byteLength > this.maxBytes) throw new Error(`artifact exceeds ${this.maxBytes} byte limit`);
    const filename = safeArtifactFilename(input.filename, `attachment-${randomUUID().slice(0, 8)}${extensionOf(input.filename ?? "")}`); const targetRelative = input.workspaceRelativePath ?? join("attachments", "generated", filename); const { workspace, attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot); const target = resolve(workspace, targetRelative);
    if (!inside(attachmentsRoot, target)) throw new Error("workspace attachment path escapes attachments root"); await assertNoSymlink(dirname(target), attachmentsRoot); const targetMetadata = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }); if (targetMetadata?.isSymbolicLink()) throw new Error("symlink paths are not allowed for workspace attachments");
    const location = await writeWorkspaceFileExclusive(target, input.bytes, randomUUID(), attachmentsRoot);
    try { return await this.createArtifact({ bytes: input.bytes, ownerPrincipalId: input.ownerPrincipalId, filename: basename(location), ...(input.mediaType ? { mediaType: input.mediaType } : {}), ...(input.parentSource ? { parentSource: input.parentSource } : {}), location }); } catch (error) { await rm(location, { force: true }); throw error; }
  }

  async resolveArtifactFile(artifact: Artifact): Promise<ResolvedWorkspaceArtifact> {
    const { attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot);
    const valid = async (candidate: string): Promise<ResolvedWorkspaceArtifact | undefined> => {
      try { const path = await safeExistingAttachment(candidate, attachmentsRoot); const metadata = await stat(path); if (metadata.size !== artifact.size) return undefined; const bytes = new Uint8Array(await readFile(path)); if (bytes.byteLength !== artifact.size || hashBytes(bytes) !== artifact.sha256) return undefined; const resolvedArtifact = { ...artifact, location: path, filename: basename(path), size: bytes.byteLength, updatedAt: this.now() }; if (path !== artifact.location || artifact.filename !== resolvedArtifact.filename) await this.store.updateArtifactLocation?.({ artifactId: artifact.id, location: path, filename: resolvedArtifact.filename, size: bytes.byteLength, sha256: artifact.sha256, updatedAt: resolvedArtifact.updatedAt }); return { artifact: resolvedArtifact, path, bytes }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && /inside workspace|symlink|regular file/.test(error.message)) return undefined; throw error; }
    };
    const located = await valid(artifact.location); if (located) return located;
    const visit = async (directory: string): Promise<ResolvedWorkspaceArtifact | undefined> => { const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }); for (const entry of entries) { const candidate = join(directory, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) { const found = await visit(candidate); if (found) return found; } else if (entry.isFile()) { const found = await valid(candidate); if (found) return found; } } return undefined; };
    const recovered = await visit(attachmentsRoot); if (recovered) return recovered; throw new Error("artifact bytes are unavailable");
  }

  async getWorkspaceRelativePath(artifactId: string): Promise<string | undefined> { const artifact = await this.store.getArtifact(artifactId); if (!artifact || artifact.state === "deleted") return undefined; try { return relative(await realpath(this.workspaceRoot), (await this.resolveArtifactFile(artifact)).path); } catch { return undefined; } }
  async moveWorkspaceFile(input: { readonly sourcePath: string; readonly destinationPath: string }): Promise<{ readonly oldPath: string; readonly newPath: string }> {
    const { workspace, attachmentsRoot } = await safeWorkspaceRoots(this.workspaceRoot); const source = await safeExistingAttachment(this.inputPath(workspace, input.sourcePath), attachmentsRoot); const destination = resolve(workspace, this.stripWorkspace(input.destinationPath)); if (!inside(attachmentsRoot, destination)) throw new Error("path must be inside workspace attachments"); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await assertNoSymlink(dirname(destination), attachmentsRoot); const resolvedParent = await realpath(dirname(destination)); if (!insideOrRoot(attachmentsRoot, resolvedParent)) throw new Error("path must be inside workspace attachments"); try { await link(source, destination); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("destination already exists"); throw error; } try { await unlink(source); } catch (error) { await rm(destination, { force: true }); throw error; } return { oldPath: relative(workspace, source), newPath: relative(workspace, destination) };
  }
  private inputPath(workspace: string, input: string): string { return resolve(workspace, this.stripWorkspace(input)); }
  private stripWorkspace(input: string): string { return input === "workspace" ? "" : input.startsWith(`workspace${sep}`) ? input.slice(`workspace${sep}`.length) : input; }
  private async createArtifact(input: { readonly bytes: Uint8Array; readonly ownerPrincipalId: string; readonly filename?: string; readonly mediaType?: string; readonly parentSource?: { readonly kind: string; readonly id: string }; readonly location: string }): Promise<Artifact> {
    const id = randomUUID(); const at = this.now(); const mediaType = input.mediaType ?? "application/octet-stream"; const extractedText = await extractArtifactTextAsync(mediaType, input.bytes); const artifact: Artifact = { id, ownerPrincipalId: input.ownerPrincipalId, visibility: "shared", mediaType, ...(input.filename ? { filename: safeArtifactFilename(input.filename, `attachment-${id.slice(0, 8)}`) } : {}), size: input.bytes.byteLength, sha256: hashBytes(input.bytes), location: input.location, ...(extractedText !== undefined ? { extractedText } : {}), ...(input.parentSource ? { parentSource: input.parentSource } : {}), state: "stored", createdAt: at, updatedAt: at }; await this.store.createArtifact({ artifact }); return artifact;
  }
}
