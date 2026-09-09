import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { parseDiscordTriggerPolicy } from "@umiro/adapter-discord";

const EDITABLE_FILES = new Set(["SOUL.md", "AGENT.md", "OWNER.md", "MEMORY.md", "PEOPLE.md"]);
const MAX_BODY = 1024 * 1024;

export interface ControlPanelSchedules {
  list(): Promise<unknown>;
  create(input: { readonly name: string; readonly kind: "cron" | "once"; readonly expression?: string; readonly at?: string; readonly timezone: string; readonly prompt: string; readonly channelId?: string }): Promise<unknown>;
  setEnabled(id: string, enabled: boolean): Promise<unknown>;
  remove(id: string): Promise<boolean>;
}
export interface ControlPanelPlugins { list(): Promise<unknown>; run(action: "install" | "configure" | "enable" | "disable" | "update" | "remove", source: string, workspace?: string, config?: Record<string, unknown>): Promise<unknown> }
export interface ControlPanelApprovals { list(): Promise<unknown>; resolve(id: string, action: "approve" | "deny"): Promise<unknown> }
export interface ControlPanelRuns { list(limit: number): Promise<unknown>; get(id: string): Promise<unknown | undefined> }
export interface GatewayReadiness {
  readonly storage: boolean;
  readonly plugins: boolean;
  readonly discord: boolean;
  readonly scheduler: boolean;
  readonly shuttingDown?: boolean;
}
export interface ControlPanelOptions { readonly host: string; readonly port: number; readonly token: string; readonly configFile: string; readonly workspace: string; readonly schedules?: ControlPanelSchedules; readonly plugins?: ControlPanelPlugins; readonly approvals?: ControlPanelApprovals; readonly runs?: ControlPanelRuns; readonly logs?: (limit: number) => Promise<unknown> | unknown; readonly runtime?: () => Promise<unknown> | unknown; readonly readiness?: () => Promise<GatewayReadiness> | GatewayReadiness; readonly processId?: number }

export const CONFIG_EXPLANATIONS = {
  model: { label: "主要模型", description: "Discord 對話與未指定模型的 Run 使用的模型 ID。", restartRequired: true },
  modelCapabilities: { label: "模型能力", description: "模型明確支援的能力清單，例如 vision、function_tools、hosted_web_search；未宣告的 hosted 能力不會暴露為工具。", restartRequired: true },
  "embedding.provider": { label: "Embedding provider", description: "disabled、gemini 或 openai-compatible；disabled 時只用 FTS。", restartRequired: true },
  "embedding.model": { label: "Embedding model", description: "啟用 embedding 時使用的模型 ID，不可寫死為內建模型。", restartRequired: true },
  "embedding.baseUrl": { label: "Embedding API URL", description: "OpenAI-compatible embedding endpoint 的基底 URL。", restartRequired: true },
  "embedding.apiKeyEnv": { label: "Embedding credential 變數", description: "secrets.env 中存放 API key 的環境變數名稱；不是 key 本身。", restartRequired: true },
  "discord.ignoredChannels": { label: "完全忽略頻道", description: "不記錄、不回覆；精確比對 channel/thread ID，優先級最高。", restartRequired: true },
  "discord.ambientChannels": { label: "Ambient 頻道", description: "不需 mention 即觸發；仍必須通過 guild/channel scope。", restartRequired: true },
  "discord.allowedChannels": { label: "允許頻道", description: "所有人（包含 Owner）在伺服器內可使用的 channel/thread ID；空陣列表示不以此項限制。", restartRequired: true },
  "discord.allowedGuilds": { label: "允許伺服器", description: "所有人（包含 Owner）可使用的 guild ID；空陣列表示不以此項限制。", restartRequired: true },
  "discord.respondToBots": { label: "回應其他 Bot", description: "是否允許其他 bot 觸發；自己的訊息永遠忽略以避免迴圈。", restartRequired: true },
  "discord.presence.status": { label: "Discord 狀態", description: "Bot 顯示為 online、idle、dnd 或 invisible。", restartRequired: true },
  "discord.presence.activity": { label: "Discord 活動文字", description: "Bot 名稱下方顯示的活動文字。", restartRequired: true },
  "plugins[].path": { label: "外部外掛路徑", description: "由 config 直接載入的外部外掛位置；一般操作建議使用外掛管理介面。", restartRequired: true },
  "plugins[].config": { label: "外部外掛設定", description: "傳給該外掛 manifest schema 驗證的非秘密設定。", restartRequired: true },
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
  const config = value as Record<string, unknown>; const allowed = new Set(["model", "modelCapabilities", "embedding", "discord", "plugins", "webUi"]);
  const unknown = Object.keys(config).find(key => !allowed.has(key)); if (unknown) throw new TypeError(`unsupported config field: ${unknown}`);
  if (typeof config.model !== "string" || !config.model.trim()) throw new TypeError("model must be a non-empty string");
  const knownCapabilities = new Set(["vision", "function_tools", "hosted_web_search", "hosted_image_generation", "hosted_code_execution"]);
  if (config.modelCapabilities !== undefined && (!Array.isArray(config.modelCapabilities) || config.modelCapabilities.some(item => typeof item !== "string" || !knownCapabilities.has(item)) || new Set(config.modelCapabilities).size !== config.modelCapabilities.length)) throw new TypeError("modelCapabilities must contain unique supported capability names");
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

const HTML = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ümiro 控制台</title><style>body{font:15px system-ui;max-width:1100px;margin:30px auto;padding:0 16px;background:#111;color:#eee}button,input,select,textarea{font:inherit}input,textarea,select{box-sizing:border-box;width:100%;background:#1d1d1d;color:#eee;border:1px solid #555;padding:8px}textarea{height:360px}button{width:auto;padding:8px 14px;margin:6px 4px 6px 0}section{border:1px solid #444;padding:16px;margin:16px 0}small{color:#aaa}.files button{font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.schedule,.plugin,.approval,.run{border-top:1px solid #444;padding:8px 0}pre{white-space:pre-wrap}</style><h1>ümiro V2 控制台</h1><section><label>Web UI Token<input id="token" type="password" autocomplete="off"></label><button id="connect">連線</button><span id="state"></span><pre id="runtime"></pre></section><section><h2>最近 Runs</h2><button id="refreshRuns">重新整理</button><div id="runs"></div><pre id="runDetail"></pre></section><section><h2>待核准操作</h2><button id="refreshApprovals">重新整理</button><div id="approvals"></div></section><section><h2>設定</h2><div id="help"></div><textarea id="config"></textarea><button id="saveConfig">儲存設定</button><small>標示需重啟的設定會在下次 daemon 啟動生效。</small></section><section><h2>Agent Workspace</h2><div class="files" id="files"></div><h3 id="filename">尚未選擇檔案</h3><textarea id="document"></textarea><button id="saveDocument">儲存文件</button></section><section><h2>Cron／Reminder</h2><div class="grid"><input id="scheduleName" placeholder="名稱"><select id="scheduleKind"><option value="cron">Cron</option><option value="once">一次性 Reminder</option></select><input id="scheduleWhen" placeholder="cron expression 或 ISO 時間"><input id="scheduleTimezone" value="Asia/Taipei" placeholder="Timezone"><input id="scheduleChannel" placeholder="Discord channel ID（可留空）"></div><textarea id="schedulePrompt" placeholder="Agent prompt" style="height:100px"></textarea><button id="createSchedule">建立</button><button id="refreshSchedules">重新整理</button><div id="schedules"></div></section><section><h2>內建能力／外部外掛</h2><input id="pluginSource" placeholder="外部外掛 GitHub HTTPS URL 或本機路徑"><input id="pluginWorkspace" placeholder="monorepo workspace（可留空）"><button id="installPlugin">安裝外掛</button><button id="refreshPlugins">重新整理</button><small>內建能力隨 ümiro 出貨，可停用但不可移除；外部外掛由使用者安裝。變更在重啟 daemon 後完整生效。</small><div id="plugins"></div></section><script src="/app.js"></script></html>`;
const JS = `
const $=id=>document.getElementById(id);let file;
const names=['SOUL.md','AGENT.md','OWNER.md','MEMORY.md','PEOPLE.md'];
const headers=()=>({'authorization':'Bearer '+$('token').value,'content-type':'application/json'});
async function api(path,options={}){const r=await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}});const data=await r.json();if(!r.ok)throw new Error(data.error||r.statusText);return data}
async function schedules(){const items=await api('/api/schedules');$('schedules').replaceChildren(...items.map(x=>{const d=document.createElement('div');d.className='schedule';const label=document.createElement('span');label.textContent=x.name+' — '+JSON.stringify(x.schedule)+' — '+(x.enabled?'啟用':'停用');const toggle=document.createElement('button');toggle.textContent=x.enabled?'停用':'啟用';toggle.onclick=()=>api('/api/schedules/'+encodeURIComponent(x.id),{method:'PATCH',body:JSON.stringify({enabled:!x.enabled})}).then(schedules);const remove=document.createElement('button');remove.textContent='刪除';remove.onclick=()=>confirm('確定刪除？')&&api('/api/schedules/'+encodeURIComponent(x.id),{method:'DELETE'}).then(schedules);d.append(label,toggle,remove);return d}))}
async function pluginAction(action,source,workspace,config){await api('/api/plugins/action',{method:'POST',body:JSON.stringify({action,source,workspace,config})});await plugins()}
async function plugins(){const items=await api('/api/plugins');$('plugins').replaceChildren(...items.map(x=>{const d=document.createElement('div');d.className='plugin';const builtin=x.source.startsWith('builtin:');const label=document.createElement('span');label.textContent=(builtin?'內建能力':'外部外掛')+' — '+(x.enabled?'啟用':'停用')+' — '+x.source;const toggle=document.createElement('button');toggle.textContent=x.enabled?'停用':'啟用';toggle.onclick=()=>pluginAction(x.enabled?'disable':'enable',x.source,x.workspace);const configure=document.createElement('button');configure.textContent='設定';configure.onclick=()=>{const value=prompt('JSON config',JSON.stringify(x.config||{},null,2));if(value!==null)pluginAction('configure',x.source,x.workspace,JSON.parse(value)).catch(e=>alert(e.message))};d.append(label,toggle,configure);if(!builtin){const update=document.createElement('button');update.textContent='更新';update.onclick=()=>pluginAction('update',x.source,x.workspace).catch(e=>alert(e.message));const remove=document.createElement('button');remove.textContent='移除';remove.onclick=()=>confirm('確定移除？')&&pluginAction('remove',x.source,x.workspace).catch(e=>alert(e.message));d.append(update,remove)}return d}))}
async function approvals(){const items=await api('/api/approvals');$('approvals').replaceChildren(...items.map(x=>{const d=document.createElement('div');d.className='approval';const label=document.createElement('pre');label.textContent=x.operation+'\n到期：'+x.expiresAt+'\n'+x.details;const approve=document.createElement('button');approve.textContent='核准';approve.onclick=()=>api('/api/approvals/'+encodeURIComponent(x.id),{method:'POST',body:JSON.stringify({action:'approve'})}).then(approvals).catch(e=>alert(e.message));const deny=document.createElement('button');deny.textContent='拒絕';deny.onclick=()=>api('/api/approvals/'+encodeURIComponent(x.id),{method:'POST',body:JSON.stringify({action:'deny'})}).then(approvals).catch(e=>alert(e.message));d.append(label,approve,deny);return d}))}
async function runs(){const items=await api('/api/runs?limit=30');$('runs').replaceChildren(...items.map(x=>{const d=document.createElement('div');d.className='run';const b=document.createElement('button');b.textContent=x.id;const label=document.createElement('span');label.textContent=x.state+' — '+x.origin+' — '+x.updatedAt+(x.usage?' — '+x.usage.inputTokens+' in / '+x.usage.outputTokens+' out':'');b.onclick=async()=>{$('runDetail').textContent=JSON.stringify(await api('/api/runs/'+encodeURIComponent(x.id)),null,2)};d.append(b,label);return d}))}
async function connect(){localStorage.umiroToken=$('token').value;const [schema,config,runtime]=await Promise.all([api('/api/schema'),api('/api/config'),api('/api/runtime')]);$('help').innerHTML=Object.values(schema).map(x=>'<p><b>'+x.label+'</b> — '+x.description+(x.restartRequired?' <small>（需重啟）</small>':'')+'</p>').join('');$('config').value=JSON.stringify(config,null,2);$('runtime').textContent=JSON.stringify(runtime,null,2);await Promise.all([runs(),schedules(),plugins(),approvals()]);$('state').textContent='已連線'}
async function load(name){const x=await api('/api/workspace/'+name);file=name;$('filename').textContent=name;$('document').value=x.content}
names.forEach(n=>{const b=document.createElement('button');b.textContent=n;b.onclick=()=>load(n).catch(e=>alert(e.message));$('files').appendChild(b)});
$('connect').onclick=()=>connect().catch(e=>$('state').textContent=e.message);
$('saveConfig').onclick=()=>api('/api/config',{method:'PUT',body:$('config').value}).then(()=>alert('已儲存')).catch(e=>alert(e.message));
$('saveDocument').onclick=()=>file?api('/api/workspace/'+file,{method:'PUT',body:JSON.stringify({content:$('document').value})}).then(()=>alert('已儲存')).catch(e=>alert(e.message)):alert('請先選檔案');
$('refreshSchedules').onclick=()=>schedules().catch(e=>alert(e.message));
$('createSchedule').onclick=()=>{const kind=$('scheduleKind').value;const when=$('scheduleWhen').value;api('/api/schedules',{method:'POST',body:JSON.stringify({name:$('scheduleName').value,kind,expression:kind==='cron'?when:undefined,at:kind==='once'?when:undefined,timezone:$('scheduleTimezone').value,prompt:$('schedulePrompt').value,channelId:$('scheduleChannel').value||undefined})}).then(schedules).catch(e=>alert(e.message))};
$('refreshPlugins').onclick=()=>plugins().catch(e=>alert(e.message));
$('installPlugin').onclick=()=>pluginAction('install',$('pluginSource').value,$('pluginWorkspace').value||undefined).catch(e=>alert(e.message));
$('refreshApprovals').onclick=()=>approvals().catch(e=>alert(e.message));
$('refreshRuns').onclick=()=>runs().catch(e=>alert(e.message));
$('token').value=localStorage.umiroToken||'';
`;

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
      if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "alive" });
      if (request.method === "GET" && url.pathname === "/readyz") {
        const checks = this.options.readiness ? await this.options.readiness() : { storage: true, plugins: true, discord: true, scheduler: true };
        const ready = checks.storage && checks.plugins && checks.discord && checks.scheduler && checks.shuttingDown !== true;
        return json(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", pid: this.options.processId ?? process.pid, checks });
      }
      if (!this.authorized(request)) return json(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && url.pathname === "/api/schema") return json(response, 200, CONFIG_EXPLANATIONS);
      if (request.method === "GET" && url.pathname === "/api/config") return json(response, 200, JSON.parse(await readFile(this.options.configFile, "utf8")));
      if (request.method === "PUT" && url.pathname === "/api/config") { const config = validateControlConfig(await body(request)); await atomicWrite(this.options.configFile, `${JSON.stringify(config, null, 2)}\n`); return json(response, 200, { saved: true, restartRequired: true }); }
      if (request.method === "GET" && url.pathname === "/api/schedules") { if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); return json(response, 200, await this.options.schedules.list()); }
      if (request.method === "POST" && url.pathname === "/api/schedules") {
        if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); const input = await body(request) as Record<string, unknown>;
        if (typeof input.name !== "string" || !input.name.trim() || (input.kind !== "cron" && input.kind !== "once") || typeof input.timezone !== "string" || !input.timezone || typeof input.prompt !== "string" || !input.prompt.trim()) throw new TypeError("name, kind, timezone and prompt are required");
        if (input.kind === "cron" && typeof input.expression !== "string") throw new TypeError("cron expression is required"); if (input.kind === "once" && typeof input.at !== "string") throw new TypeError("reminder time is required");
        return json(response, 201, await this.options.schedules.create({ name: input.name.trim(), kind: input.kind, ...(input.kind === "cron" ? { expression: input.expression as string } : { at: input.at as string }), timezone: input.timezone, prompt: input.prompt, ...(typeof input.channelId === "string" && input.channelId ? { channelId: input.channelId } : {}) }));
      }
      const scheduleMatch = /^\/api\/schedules\/([A-Za-z0-9._:-]{1,160})$/.exec(url.pathname); const scheduleId = scheduleMatch?.[1];
      if (scheduleId && request.method === "PATCH") { if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); const input = await body(request) as { enabled?: unknown }; if (typeof input.enabled !== "boolean") throw new TypeError("enabled must be boolean"); return json(response, 200, await this.options.schedules.setEnabled(scheduleId, input.enabled)); }
      if (scheduleId && request.method === "DELETE") { if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); return json(response, 200, { removed: await this.options.schedules.remove(scheduleId) }); }
      if (request.method === "GET" && url.pathname === "/api/plugins") { if (!this.options.plugins) return json(response, 503, { error: "plugin manager unavailable" }); return json(response, 200, await this.options.plugins.list()); }
      if (request.method === "POST" && url.pathname === "/api/plugins/action") {
        if (!this.options.plugins) return json(response, 503, { error: "plugin manager unavailable" }); const input = await body(request) as Record<string, unknown>;
        if (input.action !== "install" && input.action !== "configure" && input.action !== "enable" && input.action !== "disable" && input.action !== "update" && input.action !== "remove") throw new TypeError("unsupported plugin action");
        if (typeof input.source !== "string" || !input.source.trim()) throw new TypeError("plugin source is required");
        if (input.config !== undefined && (!input.config || typeof input.config !== "object" || Array.isArray(input.config))) throw new TypeError("plugin config must be an object");
        return json(response, 200, await this.options.plugins.run(input.action, input.source, typeof input.workspace === "string" && input.workspace ? input.workspace : undefined, input.config as Record<string, unknown> | undefined));
      }
      if (request.method === "GET" && url.pathname === "/api/runtime") return json(response, 200, this.options.runtime ? await this.options.runtime() : { status: "running" });
      if (request.method === "GET" && url.pathname === "/api/logs") { if (!this.options.logs) return json(response, 503, { error: "log view unavailable" }); const raw = url.searchParams.get("limit") ?? "100"; if (!/^\d{1,3}$/.test(raw)) throw new TypeError("log limit must be an integer"); const limit = Number(raw); if (limit < 1 || limit > 500) throw new TypeError("log limit must be between 1 and 500"); return json(response, 200, await this.options.logs(limit)); }
      if (request.method === "GET" && url.pathname === "/api/runs") { if (!this.options.runs) return json(response, 503, { error: "run query unavailable" }); const raw = url.searchParams.get("limit") ?? "50"; if (!/^\d{1,3}$/.test(raw)) throw new TypeError("run limit must be an integer"); const limit = Number(raw); if (limit < 1 || limit > 200) throw new TypeError("run limit must be between 1 and 200"); return json(response, 200, await this.options.runs.list(limit)); }
      const runMatch = /^\/api\/runs\/([A-Za-z0-9._:-]{1,160})$/.exec(url.pathname); const runId = runMatch?.[1];
      if (request.method === "GET" && runId) { if (!this.options.runs) return json(response, 503, { error: "run query unavailable" }); const result = await this.options.runs.get(runId); return result === undefined ? json(response, 404, { error: "run not found" }) : json(response, 200, result); }
      if (request.method === "GET" && url.pathname === "/api/approvals") { if (!this.options.approvals) return json(response, 503, { error: "approval service unavailable" }); return json(response, 200, await this.options.approvals.list()); }
      const approvalMatch = /^\/api\/approvals\/([A-Za-z0-9._-]{1,64})$/.exec(url.pathname); const approvalId = approvalMatch?.[1];
      if (approvalId && request.method === "POST") { if (!this.options.approvals) return json(response, 503, { error: "approval service unavailable" }); const input = await body(request) as { action?: unknown }; if (input.action !== "approve" && input.action !== "deny") throw new TypeError("approval action must be approve or deny"); return json(response, 200, await this.options.approvals.resolve(approvalId, input.action)); }
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
