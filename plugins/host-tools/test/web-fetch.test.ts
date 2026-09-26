import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginSetupContext } from "@umiro/core/plugin";
import type { JsonObject } from "@umiro/core/ports";
import type { ToolExecutionContext, ToolExecutionResult } from "@umiro/core/tool";
import { createPlugin } from "../src/index.js";
import { MAX_WEB_BODY_CHARACTERS } from "../src/web-content.js";

const authority = { capabilities: ["web.fetch"], visibility: { kind: "all" as const }, instructionAuthority: "none" as const };
const execution: ToolExecutionContext = { operationId: "operation", signal: new AbortController().signal, execution: { origin: { kind: "interactive", transport: "test", conversationId: "c" }, actor: { id: "owner", kind: "human", roles: ["owner"] }, authority } };

async function withWebFetch(run: (fetchPage: (input: JsonObject) => Promise<ToolExecutionResult>) => Promise<void>, maxWebBytes = 2 * 1024 * 1024): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "umiro-web-fetch-"));
  const previousFetch = globalThis.fetch;
  const setup = { pluginId: "host-tools", namespace: "host-tools", permissionCeiling: authority, config: { workspacePath: root, maxWebBytes }, getSecret() { return undefined; } } satisfies PluginSetupContext;
  const plugin = createPlugin(setup);
  await plugin.start?.();
  const webFetch = plugin.contributions.tools!.find(tool => tool.name === "web_fetch")!;
  try { await run(input => webFetch.execute(input, execution)); }
  finally { globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
}

test("web_fetch keeps late specifications while bounding large HTML", async () => {
  await withWebFetch(async fetchPage => {
    const filler = Array.from({ length: 2_000 }, (_, index) => `<p>Ordinary filler text at position ${index} across the page.</p>`).join("");
    const html = `<!doctype html><html><head><title>CORSAIR XENEON &amp; Display</title><style>${"x".repeat(300_000)}</style></head><body><nav>Noise menu</nav><script>${"y".repeat(500_000)}</script>${filler}<table><tr><th>Resolution</th><td>2560 &times; 1600</td></tr><tr><th>Ports</th><td>HDMI &amp; USB-C</td></tr></table><h2>Price &pound;299</h2></body></html>`;
    const sourceBytes = Buffer.byteLength(html);
    globalThis.fetch = async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    const result = await fetchPage({ url: "https://8.8.8.8/product" });
    assert.equal(result.ok, true);
    const output = result.ok ? result.output as { url: string; status: number; body: string; bodyBytes: number; truncated: boolean; extraction: string } : undefined;
    assert.equal(output?.url, "https://8.8.8.8/product");
    assert.equal(output?.status, 200);
    assert.equal(output?.bodyBytes, sourceBytes);
    assert.equal(output?.truncated, true);
    assert.equal(output?.extraction, "readable_text");
    assert.equal(MAX_WEB_BODY_CHARACTERS, 50_000);
    assert.ok((output?.body.length ?? 0) <= MAX_WEB_BODY_CHARACTERS);
    assert.match(output?.body ?? "", /CORSAIR XENEON & Display|2560 × 1600/);
    assert.match(output?.body ?? "", /HDMI & USB-C/);
    assert.match(output?.body ?? "", /Price £299/);
    assert.doesNotMatch(output?.body ?? "", /Noise menu|xxxx|yyyy|<table>/);
  });
});

test("web_fetch bounds text and JSON, reports non-text and HEAD metadata", async () => {
  await withWebFetch(async fetchPage => {
    let type = "text/plain";
    let method = "";
    globalThis.fetch = async (_url, init) => { method = init?.method ?? "GET"; return new Response(method === "HEAD" ? null : type === "application/octet-stream" ? new Uint8Array([1, 2, 3]) : "A".repeat(60_000), { status: 200, headers: { "content-type": type, "content-length": method === "HEAD" ? "9000000" : "60000" } }); };
    const textResult = await fetchPage({ url: "https://8.8.8.8/text" });
    assert.equal(textResult.ok, true);
    assert.equal((textResult.output as { body: string }).body.length, 50_000);
    assert.equal((textResult.output as { truncated: boolean }).truncated, true);
    type = "application/json";
    const jsonResult = await fetchPage({ url: "https://8.8.8.8/data" });
    assert.equal((jsonResult.output as { body: string }).body.length, 50_000);
    type = "application/octet-stream";
    const binaryResult = await fetchPage({ url: "https://8.8.8.8/file" });
    assert.equal((binaryResult.output as { body: string }).body, "");
    assert.equal((binaryResult.output as { extraction: string }).extraction, "non_text");
    const headResult = await fetchPage({ url: "https://8.8.8.8/file", method: "HEAD" });
    assert.equal(method, "HEAD");
    assert.deepEqual(headResult.output, { url: "https://8.8.8.8/file", status: 200, contentType: "application/octet-stream", declaredBytes: 9_000_000 });
  });
});

test("web_fetch rejects streamed oversize bodies and unsafe redirects", async () => {
  await withWebFetch(async fetchPage => {
    globalThis.fetch = async () => new Response("small", { headers: { "content-type": "text/plain", "content-length": "1025" } });
    const declaredOversized = await fetchPage({ url: "https://8.8.8.8/large" });
    assert.equal(declaredOversized.ok, false);
    assert.match(declaredOversized.ok ? "" : declaredOversized.error.message, /web response exceeds 1024 bytes/);
    globalThis.fetch = async () => new Response("a".repeat(1025), { headers: { "content-type": "text/plain" } });
    const oversized = await fetchPage({ url: "https://8.8.8.8/large" });
    assert.equal(oversized.ok, false);
    assert.match(oversized.ok ? "" : oversized.error.message, /web response exceeds 1024 bytes/);
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); };
    const redirect = await fetchPage({ url: "https://8.8.8.8/redirect" });
    assert.equal(redirect.ok, false);
    assert.equal(calls, 1);
    globalThis.fetch = async url => String(url).includes("8.8.8.8")
      ? new Response(null, { status: 302, headers: { location: "https://9.9.9.9/final" } })
      : new Response("Final page", { status: 200, headers: { "content-type": "text/plain" } });
    const final = await fetchPage({ url: "https://8.8.8.8/redirect" });
    assert.equal(final.ok, true);
    assert.equal((final.output as { url: string }).url, "https://9.9.9.9/final");
  }, 1024);
});

test("web_fetch marks script-only pages as unreadable", async () => {
  await withWebFetch(async fetchPage => {
    globalThis.fetch = async () => new Response("<html><script>window.data={price:299}</script></html>", { headers: { "content-type": "text/html" } });
    const result = await fetchPage({ url: "https://8.8.8.8/dynamic" });
    assert.equal(result.ok, true);
    assert.equal((result.output as { extraction: string }).extraction, "none");
    assert.doesNotMatch((result.output as { body: string }).body, /299/);
  });
});
