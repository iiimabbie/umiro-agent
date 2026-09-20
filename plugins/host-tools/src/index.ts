import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { lstat, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { JsonObject } from "@umiro/core/ports";
import type { PluginInstance, PluginSetupContext } from "@umiro/core/plugin";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from "@umiro/core/tool";

interface Config { readonly workspacePath: string; readonly maxReadBytes?: number; readonly maxWebBytes?: number; readonly allowedWebHosts?: readonly string[] }
const ok = (output: unknown, effectStatus: "not_applicable" | "confirmed"): ToolExecutionResult => ({ ok: true, output: output as never, effectStatus });
const failed = (error: unknown, effectStatus: "not_applicable" | "unknown" = "not_applicable"): ToolExecutionResult => ({ ok: false, effectStatus, error: { code: "host_tool_error", message: error instanceof Error ? error.message : String(error), retryable: false } });

function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)); }
async function existingPath(root: string, requested: string): Promise<string> { const path = await realpath(resolve(root, requested)); if (!inside(root, path)) throw new Error("path escapes the configured workspace"); return path; }
async function writablePath(root: string, requested: string): Promise<string> {
  const path = resolve(root, requested); if (!inside(root, path)) throw new Error("path escapes the configured workspace");
  const parent = await realpath(dirname(path)); if (!inside(root, parent)) throw new Error("write parent escapes the configured workspace");
  return path;
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) { const octets = address.split(".").map(Number); return octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168) || octets[0] === 0; }
  const normalized = address.toLowerCase(); if (normalized.startsWith("::ffff:")) return privateAddress(normalized.slice(7)); return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}
async function safeUrl(raw: string, allowedHosts: readonly string[] | undefined): Promise<URL> {
  const url = new URL(raw); if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("web_fetch only supports HTTP(S)");
  if (url.username || url.password) throw new Error("web_fetch URL credentials are forbidden");
  if (allowedHosts?.length && !allowedHosts.includes(url.hostname)) throw new Error(`web host is not allowed: ${url.hostname}`);
  const addresses = await lookup(url.hostname, { all: true }); if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error("web_fetch refuses private or unresolved network targets");
  return url;
}

function execute(command: string, cwd: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const normalized = command.replace(/\\\r?\n/g, " ");
  const umoLifecycle = /(?:^|[;&|()\s])(?:[^;&|()\s]*\/)?umo\s+(?:start|stop|restart)(?=$|[;&|()\s])/i;
  const serviceLifecycle = normalized.split(/[;&|\n]+/).some(segment => /\b(?:systemctl|service)\b/i.test(segment) && /\b(?:start|stop|restart)\b/i.test(segment) && /\bumiro(?:\.service)?\b/i.test(segment));
  if (umoLifecycle.test(normalized) || serviceLifecycle) throw new Error("Agent shell cannot start, stop, or restart Umiro; the user must do that manually");
  return new Promise(resolveDone => {
    const child = execFile("/bin/sh", ["-lc", command], { cwd, signal, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolveDone({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0 }));
    child.stdin?.end();
  });
}

async function boundedResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`download exceeds ${limit} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function createPlugin(setup: PluginSetupContext): PluginInstance {
  const config = setup.config as unknown as Config; let root = "";
  const artifacts = () => setup.services?.artifacts;
  const define = (definition: Omit<ToolDefinition, "execute"> & { execute: (input: JsonObject, context: ToolExecutionContext) => Promise<unknown> }): ToolDefinition => ({ ...definition, async execute(input, context) { try { return ok(await definition.execute(input, context), definition.policy.sideEffect === "none" ? "not_applicable" : "confirmed"); } catch (error) { return failed(error, definition.policy.sideEffect === "none" ? "not_applicable" : "unknown"); } } });
  const tools: ToolDefinition[] = [
    define({ name: "list_files", description: "List files inside the configured agent workspace.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } } }, policy: { capability: "filesystem.read", tier: "privileged", interactionRequirement: "not_required", sideEffect: "none" }, async execute(input) { const path = await existingPath(root, String(input.path ?? ".")); const entries = await readdir(path, { withFileTypes: true }); return { path: relative(root, path) || ".", entries: entries.slice(0, 500).map(item => ({ name: item.name, type: item.isDirectory() ? "directory" : item.isFile() ? "file" : "other" })) }; } }),
    define({ name: "read_file", description: "Read one UTF-8 file inside the configured agent workspace.", inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1 } } }, policy: { capability: "filesystem.read", tier: "privileged", interactionRequirement: "not_required", sideEffect: "none", resource: input => ({ kind: "workspace_path", id: String(input.path) }) }, async execute(input) { const path = await existingPath(root, String(input.path)); const metadata = await stat(path); const limit = config.maxReadBytes ?? 1024 * 1024; if (!metadata.isFile() || metadata.size > limit) throw new Error(`file must be regular and no larger than ${limit} bytes`); return { path: relative(root, path), content: await readFile(path, "utf8") }; } }),
    define({ name: "write_file", description: "Atomically replace one UTF-8 file inside the configured agent workspace.", inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string", minLength: 1 }, content: { type: "string", maxLength: 1048576 } } }, policy: { capability: "filesystem.write", tier: "privileged", interactionRequirement: "not_required", sideEffect: "idempotent", resource: input => ({ kind: "workspace_path", id: String(input.path) }) }, async execute(input) { const path = await writablePath(root, String(input.path)); const temporary = `${path}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, String(input.content), { mode: 0o600 }); await rename(temporary, path); return { path: relative(root, path), bytes: Buffer.byteLength(String(input.content)) }; } }),
    define({ name: "bash", description: "Execute a non-interactive shell command in the configured agent workspace (30 seconds, 1 MiB output). Never start, stop, or restart Umiro: plugin changes must remain pending until the user manually restarts it. Use move_file, not shell mv, to rename files under attachments/ so artifact metadata updates immediately; use download_file for durable public downloads.", inputSchema: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", minLength: 1, maxLength: 20000 } } }, policy: { capability: "shell.execute", tier: "privileged", interactionRequirement: "not_required", sideEffect: "non_idempotent", timeoutMs: 35_000 }, async execute(input, context) { return execute(String(input.command), root, context.signal); } }),
    define({ name: "move_file", description: "Move one workspace attachment and keep its artifact database mapping synchronized.", inputSchema: { type: "object", additionalProperties: false, required: ["source", "destination"], properties: { source: { type: "string", minLength: 1 }, destination: { type: "string", minLength: 1 } } }, policy: { capability: "filesystem.write", tier: "privileged", interactionRequirement: "not_required", sideEffect: "idempotent", resource: input => ({ kind: "workspace_path", id: String(input.source) }) }, async execute(input) { const service = artifacts(); if (!service) throw new Error("artifact service is unavailable"); return service.moveWorkspaceFile({ sourcePath: String(input.source), destinationPath: String(input.destination) }); } }),
    define({ name: "download_file", description: "Download a public HTTP(S) file into workspace/attachments/downloads and register an artifact.", inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1 }, filename: { type: "string", minLength: 1, maxLength: 120 } } }, policy: { capability: "web.fetch", tier: "sensitive", interactionRequirement: "not_required", sideEffect: "non_idempotent", timeoutMs: 30_000, resource: input => ({ kind: "url", id: String(input.url), labels: ["public-web", "file-download"] }) }, async execute(input, context) {
      const service = artifacts(); if (!service) throw new Error("artifact service is unavailable");
      let url = await safeUrl(String(input.url), config.allowedWebHosts); const limit = config.maxWebBytes ?? 25 * 1024 * 1024;
      for (let redirect = 0; redirect <= 5; redirect++) {
        const response = await fetch(url, { method: "GET", redirect: "manual", signal: context.signal, headers: { "user-agent": "umiro-v2/0" } });
        if (response.status >= 300 && response.status < 400) { const location = response.headers.get("location"); if (!location || redirect === 5) throw new Error("download redirect limit exceeded"); url = await safeUrl(new URL(location, url).href, config.allowedWebHosts); continue; }
        if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
        const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > limit) throw new Error(`download exceeds ${limit} bytes`);
        const bytes = await boundedResponseBytes(response, limit);
        const contentDisposition = response.headers.get("content-disposition")?.match(/filename\*?=(?:UTF-8''|\")?([^;\"]+)/i)?.[1];
        const rawFilename = typeof input.filename === "string" ? input.filename : contentDisposition ?? new URL(url).pathname.split("/").pop() ?? "download.bin";
        const filename = basename(rawFilename).replace(/[\\/\0\x00-\x1f\x7f]/g, "").trim().replace(/[. ]+$/g, "").slice(0, 120) || "download.bin";
        const artifact = await service.createFromBytes({ bytes, ownerPrincipalId: context.execution.actor.id, filename, mediaType: response.headers.get("content-type") ?? "application/octet-stream", parentSource: { kind: "url", id: url.href }, workspaceRelativePath: `attachments/downloads/${filename}` });
        const path = await service.getWorkspaceRelativePath(artifact.id);
        if (!path) throw new Error("download was stored without a workspace mapping");
        return { url: url.href.split("?")[0], path, artifactId: artifact.id, filename: basename(path), mediaType: artifact.mediaType, size: artifact.size, sha256: artifact.sha256 };
      }
      throw new Error("download redirect loop");
    } }),
    define({ name: "web_fetch", description: "Fetch a public HTTP(S) URL with redirect, private-network and response-size guards.", inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1 }, method: { enum: ["GET", "HEAD"] } } }, policy: { capability: "web.fetch", tier: "sensitive", interactionRequirement: "not_required", sideEffect: "none", timeoutMs: 30_000, resource: input => ({ kind: "url", id: String(input.url), labels: ["public-web"] }) }, async execute(input, context) {
      let url = await safeUrl(String(input.url), config.allowedWebHosts); const limit = config.maxWebBytes ?? 2 * 1024 * 1024;
      for (let redirect = 0; redirect <= 5; redirect++) {
        const response = await fetch(url, { method: input.method === "HEAD" ? "HEAD" : "GET", redirect: "manual", signal: context.signal, headers: { "user-agent": "umiro-v2/0" } });
        if (response.status >= 300 && response.status < 400) { const location = response.headers.get("location"); if (!location || redirect === 5) throw new Error("web_fetch redirect limit exceeded"); url = await safeUrl(new URL(location, url).href, config.allowedWebHosts); continue; }
        const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > limit) throw new Error(`web response exceeds ${limit} bytes`);
        const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > limit) throw new Error(`web response exceeds ${limit} bytes`);
        return { url: url.href, status: response.status, contentType: response.headers.get("content-type"), body: new TextDecoder().decode(bytes) };
      }
      throw new Error("web_fetch redirect loop");
    } }),
  ];
  return { contributions: { tools }, async start() { const metadata = await lstat(config.workspacePath); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("host-tools workspace must be a regular directory"); root = await realpath(config.workspacePath); } };
}
