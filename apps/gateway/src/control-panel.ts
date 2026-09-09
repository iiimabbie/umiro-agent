import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { parseDiscordTriggerPolicy } from "@umiro/adapter-discord";

const EDITABLE_FILES = new Set(["SOUL.md", "AGENT.md", "OWNER.md", "MEMORY.md", "PEOPLE.md"]);
const MAX_BODY = 1024 * 1024;

export interface ControlPanelOptions { readonly host: string; readonly port: number; readonly token: string; readonly configFile: string; readonly workspace: string }

export const CONFIG_EXPLANATIONS = {
  model: { label: "主要模型", description: "Discord 對話與未指定模型的 Run 使用的模型 ID。", restartRequired: true },
  "embedding.provider": { label: "Embedding provider", description: "disabled、gemini 或 openai-compatible；disabled 時只用 FTS。", restartRequired: true },
  "embedding.model": { label: "Embedding model", description: "啟用 embedding 時使用的模型 ID，不可寫死為內建模型。", restartRequired: true },
  "embedding.baseUrl": { label: "Embedding API URL", description: "OpenAI-compatible embedding endpoint 的基底 URL。", restartRequired: true },
  "embedding.apiKeyEnv": { label: "Embedding credential 變數", description: "secrets.env 中存放 API key 的環境變數名稱；不是 key 本身。", restartRequired: true },
  "discord.ignoredChannels": { label: "完全忽略頻道", description: "不記錄、不回覆；精確比對 channel/thread ID，優先級最高。", restartRequired: true },
  "discord.ambientChannels": { label: "Ambient 頻道", description: "不需 mention 即觸發；仍必須通過 guild/channel scope。", restartRequired: true },
  "discord.allowedChannels": { label: "允許頻道", description: "所有人（包含 Owner）在伺服器內可使用的 channel/thread ID；空陣列表示不以此項限制。", restartRequired: true },
  "discord.allowedGuilds": { label: "允許伺服器", description: "所有人（包含 Owner）可使用的 guild ID；空陣列表示不以此項限制。", restartRequired: true },
  "discord.respondToBots": { label: "回應其他 Bot", description: "是否允許其他 bot 觸發；自己的訊息永遠忽略以避免迴圈。", restartRequired: true },
  "plugins[].path": { label: "額外 Plugin 路徑", description: "由 config 直接載入的 Plugin 位置；一般操作建議使用 Plugin 管理介面。", restartRequired: true },
  "plugins[].config": { label: "額外 Plugin 設定", description: "傳給該 Plugin manifest schema 驗證的非秘密設定。", restartRequired: true },
  "webUi.enabled": { label: "Web UI 啟用", description: "是否啟動本機管理介面。", restartRequired: true },
  "webUi.host": { label: "Web UI host", description: "只接受 127.0.0.1 或 ::1，不可直接公開到網路。", restartRequired: true },
  "webUi.port": { label: "Web UI port", description: "本機 HTTP port，範圍 1–65535。", restartRequired: true },
} as const;

function secureEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
const SECURITY_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" } as const;
function json(response: ServerResponse, status: number, value: unknown): void { const body = JSON.stringify(value); response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) }); response.end(body); }
function text(response: ServerResponse, status: number, value: string, type = "text/plain; charset=utf-8"): void { response.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": Buffer.byteLength(value) }); response.end(value); }

async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new TypeError("content-type must be application/json");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > MAX_BODY) throw new RangeError("request body is too large"); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function validateControlConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("config must be an object");
  const config = value as Record<string, unknown>; const allowed = new Set(["model", "embedding", "discord", "plugins", "webUi"]);
  const unknown = Object.keys(config).find(key => !allowed.has(key)); if (unknown) throw new TypeError(`unsupported config field: ${unknown}`);
  if (typeof config.model !== "string" || !config.model.trim()) throw new TypeError("model must be a non-empty string");
  parseDiscordTriggerPolicy(config.discord);
  if (config.plugins !== undefined && (!Array.isArray(config.plugins) || config.plugins.some(item => !item || typeof item !== "object" || Array.isArray(item) || typeof (item as { path?: unknown }).path !== "string"))) throw new TypeError("plugins must contain objects with a path");
  if (config.embedding !== undefined && (!config.embedding || typeof config.embedding !== "object" || Array.isArray(config.embedding))) throw new TypeError("embedding must be an object");
  if (config.webUi !== undefined) {
    if (!config.webUi || typeof config.webUi !== "object" || Array.isArray(config.webUi)) throw new TypeError("webUi must be an object");
    const ui = config.webUi as Record<string, unknown>;
    if (ui.enabled !== undefined && typeof ui.enabled !== "boolean") throw new TypeError("webUi.enabled must be boolean");
    if (ui.host !== undefined && ui.host !== "127.0.0.1" && ui.host !== "::1") throw new TypeError("webUi.host must be a loopback address");
    if (ui.port !== undefined && (!Number.isSafeInteger(ui.port) || Number(ui.port) < 1 || Number(ui.port) > 65535)) throw new TypeError("webUi.port must be between 1 and 65535");
  }
  return structuredClone(config);
}

async function atomicWrite(path: string, content: string): Promise<void> { const temporary = join(dirname(path), `.${basename(path)}-${crypto.randomUUID()}.tmp`); try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; } }

const HTML = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ümiro 控制台</title><style>body{font:15px system-ui;max-width:1100px;margin:30px auto;padding:0 16px;background:#111;color:#eee}button,input,select,textarea{font:inherit}input,textarea{box-sizing:border-box;width:100%;background:#1d1d1d;color:#eee;border:1px solid #555;padding:8px}textarea{height:360px}button{padding:8px 14px;margin:6px 4px 6px 0}section{border:1px solid #444;padding:16px;margin:16px 0}small{color:#aaa}.files button{font-size:13px}</style><h1>ümiro V2 控制台</h1><section><label>Web UI Token<input id="token" type="password" autocomplete="off"></label><button id="connect">連線</button><span id="state"></span></section><section><h2>設定</h2><div id="help"></div><textarea id="config"></textarea><button id="saveConfig">儲存設定</button><small>標示需重啟的設定會在下次 daemon 啟動生效。</small></section><section><h2>Agent Workspace</h2><div class="files" id="files"></div><h3 id="filename">尚未選擇檔案</h3><textarea id="document"></textarea><button id="saveDocument">儲存文件</button></section><script src="/app.js"></script></html>`;
const JS = `const $=id=>document.getElementById(id);let file;const names=['SOUL.md','AGENT.md','OWNER.md','MEMORY.md','PEOPLE.md'];const headers=()=>({'authorization':'Bearer '+$('token').value,'content-type':'application/json'});async function api(path,options={}){const r=await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}});const data=await r.json();if(!r.ok)throw new Error(data.error||r.statusText);return data}async function connect(){localStorage.umiroToken=$('token').value;const [schema,config]=await Promise.all([api('/api/schema'),api('/api/config')]);$('help').innerHTML=Object.values(schema).map(x=>'<p><b>'+x.label+'</b> — '+x.description+(x.restartRequired?' <small>（需重啟）</small>':'')+'</p>').join('');$('config').value=JSON.stringify(config,null,2);$('state').textContent='已連線'}async function load(name){const x=await api('/api/workspace/'+name);file=name;$('filename').textContent=name;$('document').value=x.content}names.forEach(n=>{const b=document.createElement('button');b.textContent=n;b.onclick=()=>load(n).catch(e=>alert(e.message));$('files').appendChild(b)});$('connect').onclick=()=>connect().catch(e=>$('state').textContent=e.message);$('saveConfig').onclick=()=>api('/api/config',{method:'PUT',body:$('config').value}).then(()=>alert('已儲存')).catch(e=>alert(e.message));$('saveDocument').onclick=()=>file?api('/api/workspace/'+file,{method:'PUT',body:JSON.stringify({content:$('document').value})}).then(()=>alert('已儲存')).catch(e=>alert(e.message)):alert('請先選檔案');$('token').value=localStorage.umiroToken||'';`;

export class ControlPanelServer {
  private server: Server | undefined;
  constructor(private readonly options: ControlPanelOptions) { if (options.host !== "127.0.0.1" && options.host !== "::1") throw new TypeError("control panel must bind to loopback"); if (!options.token) throw new TypeError("control panel token is required"); }
  async start(): Promise<void> { if (this.server) return; this.server = createServer((request, response) => void this.handle(request, response)); await new Promise<void>((resolveReady, reject) => { this.server!.once("error", reject); this.server!.listen(this.options.port, this.options.host, resolveReady); }); }
  async stop(): Promise<void> { const server = this.server; this.server = undefined; if (server) await new Promise<void>((resolveDone, reject) => server.close(error => error ? reject(error) : resolveDone())); }
  port(): number | undefined { const address = this.server?.address(); return address && typeof address === "object" ? address.port : undefined; }
  private authorized(request: IncomingMessage): boolean { const value = request.headers.authorization; return typeof value === "string" && value.startsWith("Bearer ") && secureEqual(value.slice(7), this.options.token); }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/") return text(response, 200, HTML, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.js") return text(response, 200, JS, "text/javascript; charset=utf-8");
      if (!this.authorized(request)) return json(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && url.pathname === "/api/schema") return json(response, 200, CONFIG_EXPLANATIONS);
      if (request.method === "GET" && url.pathname === "/api/config") return json(response, 200, JSON.parse(await readFile(this.options.configFile, "utf8")));
      if (request.method === "PUT" && url.pathname === "/api/config") { const config = validateControlConfig(await body(request)); await atomicWrite(this.options.configFile, `${JSON.stringify(config, null, 2)}\n`); return json(response, 200, { saved: true, restartRequired: true }); }
      const match = /^\/api\/workspace\/([A-Z]+\.md)$/.exec(url.pathname); const name = match?.[1];
      if (name && EDITABLE_FILES.has(name)) {
        const path = join(this.options.workspace, name);
        if (request.method === "GET") return json(response, 200, { name, content: await readFile(path, "utf8") });
        if (request.method === "PUT") { const input = await body(request) as { content?: unknown }; if (typeof input.content !== "string") throw new TypeError("content must be a string"); await atomicWrite(path, input.content); return json(response, 200, { saved: true }); }
      }
      return json(response, 404, { error: "not found" });
    } catch (error) { return json(response, error instanceof RangeError ? 413 : error instanceof SyntaxError || error instanceof TypeError ? 400 : 500, { error: error instanceof Error ? error.message : "request failed" }); }
  }
}
