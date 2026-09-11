import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { parseDiscordTriggerPolicy } from "@umiro/adapter-discord";
import { validateAuthorityConfig } from "./authority-config.js";
import { assertConfigContainsNoSecrets } from "@umiro/core/config";

const BASE_EDITABLE_FILES = ["SOUL.md", "AGENT.md", "OWNER.md", "MEMORY.md"] as const;
const KNOWN_EDITABLE_FILES = new Set([...BASE_EDITABLE_FILES, "PEOPLE.md"]);
const MAX_BODY = 1024 * 1024;

export interface ControlPanelSchedules {
  list(): Promise<unknown>;
  create(input: { readonly name: string; readonly kind: "cron" | "once"; readonly expression?: string; readonly at?: string; readonly timezone: string; readonly prompt: string; readonly channelId?: string }): Promise<unknown>;
  setEnabled(id: string, enabled: boolean): Promise<unknown>;
  update?(id: string, input: { readonly name: string; readonly kind: "cron" | "once"; readonly expression?: string; readonly at?: string; readonly timezone: string; readonly prompt: string; readonly channelId?: string }): Promise<unknown>;
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
export interface ControlPanelOptions { readonly host: string; readonly port: number; readonly token: string; readonly configFile: string; readonly workspace: string; readonly workspaceFiles?: readonly string[]; readonly secrets?: () => Readonly<Record<string, boolean>>; readonly models?: () => Promise<readonly string[]>; readonly audit?: (event: string, data: Readonly<Record<string, string | number | boolean>>) => void; readonly schedules?: ControlPanelSchedules; readonly plugins?: ControlPanelPlugins; readonly approvals?: ControlPanelApprovals; readonly runs?: ControlPanelRuns; readonly logs?: (limit: number) => Promise<unknown> | unknown; readonly usage?: () => Promise<unknown> | unknown; readonly runtime?: () => Promise<unknown> | unknown; readonly readiness?: () => Promise<GatewayReadiness> | GatewayReadiness; readonly processId?: number }

export const CONFIG_EXPLANATIONS = {
  model: { label: "主要模型", description: "Discord 對話與未指定模型的 Run 使用的模型 ID。", defaultValue: null, risk: "模型必須存在於目前 API；錯誤值會使 Run 失敗。", restartRequired: true },
  protocol: { label: "模型 API protocol", description: "主要模型使用 OpenAI Responses 或 Chat Completions adapter。", defaultValue: "openai_responses", risk: "hosted web search／生圖只能搭配 Responses；同一 model ID 不可由不同 profile 指向不同 protocol。", restartRequired: true },
  profiles: { label: "模型 profiles", description: "依 profile ID 定義模型、能力與預設 reasoning；Discord session 的模型選擇會解析這些 profile。", defaultValue: {}, risk: "能力宣告過多會允許模型收到它實際不支援的請求。", restartRequired: true },
  modelCapabilities: { label: "模型能力", description: "模型明確支援的能力清單，例如 vision、function_tools、hosted_web_search。", defaultValue: [], risk: "未宣告會 fail closed；錯誤宣告可能在 provider 端失敗。", restartRequired: true },
  contextMaxTokens: { label: "Context token 上限", description: "固定文件、人物、記憶與對話歷史合計可使用的估算 token 上限。", defaultValue: 24000, risk: "過高會增加延遲與費用，過低可能放不下必要 context。", restartRequired: true },
  pricing: { label: "模型價格", description: "依 model ID 設定 inputUsdPerMillion／outputUsdPerMillion；未設定的模型不猜測成本。", defaultValue: {}, risk: "只影響估算；錯誤價格會造成控制台成本顯示不準。", restartRequired: true },
  "embedding.provider": { label: "Embedding provider", description: "disabled、gemini 或 openai-compatible；disabled 時只用 FTS。", defaultValue: "disabled", risk: "啟用後會把可索引文字送往所選 provider。", restartRequired: true },
  "embedding.model": { label: "Embedding model", description: "啟用 embedding 時使用的模型 ID，不可寫死為內建模型。", defaultValue: null, risk: "更換模型或維度會觸發 projection 重建。", restartRequired: true },
  "embedding.baseUrl": { label: "Embedding API URL", description: "OpenAI-compatible embedding endpoint 的基底 URL。", defaultValue: null, risk: "內容會傳送到此 endpoint；只能使用信任的服務。", restartRequired: true },
  "embedding.apiKeyEnv": { label: "Embedding credential 變數", description: "secrets.env 中存放 API key 的環境變數名稱；不是 key 本身。", defaultValue: null, risk: "變數不存在時 daemon 會 fail fast。", restartRequired: true },
  "discord.ignoredChannels": { label: "完全忽略頻道", description: "不記錄、不回覆；精確比對 channel/thread ID，優先級最高。", defaultValue: [], risk: "列入後該頻道的訊息完全不進入記憶。", restartRequired: true },
  "discord.ambientChannels": { label: "Ambient 頻道", description: "不需 mention 即觸發；仍必須通過 guild/channel scope。", defaultValue: [], risk: "會提高觸發頻率、模型用量與誤回覆機率。", restartRequired: true },
  "discord.allowedChannels": { label: "允許頻道", description: "所有人（包含 Owner）在伺服器內可使用的 channel/thread ID；空陣列表示不以此項限制。", defaultValue: [], risk: "空陣列不代表拒絕全部；需配合 allowedGuilds 理解範圍。", restartRequired: true },
  "discord.allowedGuilds": { label: "允許伺服器", description: "所有人（包含 Owner）可使用的 guild ID；空陣列表示不以此項限制。", defaultValue: [], risk: "設定錯誤會讓 bot 在非預期 guild 回應或完全無法使用。", restartRequired: true },
  "discord.respondToBots": { label: "回應其他 Bot", description: "是否允許其他 bot 觸發；自己的訊息永遠忽略以避免迴圈。", defaultValue: true, risk: "可能被其他 bot 的訊息觸發並增加用量。", restartRequired: true },
  "discord.queueMode": { label: "預設訊息模式", description: "queue 會等目前 Run 完成再處理；steer 會把同 session 的新訊息併入目前 Run 的下一個安全邊界。", defaultValue: "queue", risk: "steer 會讓群聊中合格的新訊息改變正在執行的 Run。", restartRequired: true },
  "discord.presence.status": { label: "Discord 狀態", description: "Bot 顯示為 online、idle、dnd 或 invisible。", defaultValue: "online", risk: "僅影響顯示狀態。", restartRequired: true },
  "discord.presence.activity": { label: "Discord 活動文字", description: "Bot 名稱下方顯示的活動文字。", defaultValue: "with ümiro", risk: "所有能看到 bot 的 Discord 使用者都能看到。", restartRequired: true },
  "authority.owner": { label: "Owner 權限", description: "Owner 的 capability、可見範圍與 instruction authority；省略時取得目前安裝能力的完整權限。", defaultValue: { visibility: { kind: "all" }, instructionAuthority: "full" }, risk: "縮小會限制 Owner；列入未安裝 capability 會讓 daemon 拒絕啟動。", restartRequired: true },
  "authority.member": { label: "一般成員權限", description: "一般成員可用的 capability 與 restricted 可見範圍；預設只開放聊天所需的 11 類能力。", defaultValue: { visibility: { kind: "restricted" }, instructionAuthority: "scoped" }, risk: "擴大 capability 或 resource visibility 會讓群組成員操作更多資料與服務。", restartRequired: true },
  "subagent.maxConcurrentChildren": { label: "每人並行下屬上限", description: "每個 Principal 同時 active 的 Child Run 數；超過直接拒絕，不排隊。", defaultValue: 2, risk: "提高並行數會同步提高模型成本；目前架構硬上限為 2。", restartRequired: true },
  "subagent.maxParallelTools": { label: "單輪並行工具上限", description: "同一 model turn 連續 parallel-safe tools 的最大並行數。", defaultValue: 2, risk: "只應用於明確宣告 parallel-safe 的工具；目前硬上限為 2。", restartRequired: true },
  "plugins[].path": { label: "外部外掛路徑", description: "由 config 直接載入的外部外掛位置；一般操作建議使用外掛管理介面。", defaultValue: [], risk: "外掛是 trusted in-process code，只能安裝信任的來源。", restartRequired: true },
  "plugins[].config": { label: "外部外掛設定", description: "傳給該外掛 manifest schema 驗證的非秘密設定。", defaultValue: {}, risk: "設定仍受 manifest schema 與 secrets 分離規則限制。", restartRequired: true },
  "webUi.enabled": { label: "Web UI 啟用", description: "是否啟動本機管理介面。", defaultValue: false, risk: "啟用後需妥善保管獨立 Web UI token。", restartRequired: true },
  "webUi.host": { label: "Web UI host", description: "只接受 127.0.0.1 或 ::1，不可直接公開到網路。", defaultValue: "127.0.0.1", risk: "公開綁定會暴露管理面，因此 validator 直接拒絕。", restartRequired: true },
  "webUi.port": { label: "Web UI port", description: "本機 HTTP port，範圍 1–65535。", defaultValue: 3210, risk: "port 衝突會使控制台啟動失敗。", restartRequired: true },
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
  assertConfigContainsNoSecrets(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("config must be an object");
  const config = value as Record<string, unknown>; const allowed = new Set(["model", "protocol", "modelCapabilities", "profiles", "contextMaxTokens", "pricing", "embedding", "discord", "authority", "subagent", "plugins", "webUi"]);
  const unknown = Object.keys(config).find(key => !allowed.has(key)); if (unknown) throw new TypeError(`unsupported config field: ${unknown}`);
  if (typeof config.model !== "string" || !config.model.trim()) throw new TypeError("model must be a non-empty string");
  if (config.protocol !== undefined && config.protocol !== "openai_responses" && config.protocol !== "openai_chat_completions") throw new TypeError("protocol must be openai_responses or openai_chat_completions");
  if (config.contextMaxTokens !== undefined && (!Number.isSafeInteger(config.contextMaxTokens) || Number(config.contextMaxTokens) < 256 || Number(config.contextMaxTokens) > 1_000_000)) throw new TypeError("contextMaxTokens must be between 256 and 1000000");
  if (config.pricing !== undefined) {
    if (!config.pricing || typeof config.pricing !== "object" || Array.isArray(config.pricing)) throw new TypeError("pricing must be an object keyed by model ID");
    for (const [model, value] of Object.entries(config.pricing)) { const rate = value as Record<string, unknown>; if (!model.trim() || !rate || typeof rate !== "object" || Array.isArray(rate) || Object.keys(rate).some(key => key !== "inputUsdPerMillion" && key !== "outputUsdPerMillion") || typeof rate.inputUsdPerMillion !== "number" || !Number.isFinite(rate.inputUsdPerMillion) || rate.inputUsdPerMillion < 0 || typeof rate.outputUsdPerMillion !== "number" || !Number.isFinite(rate.outputUsdPerMillion) || rate.outputUsdPerMillion < 0) throw new TypeError(`invalid pricing for model ${model || "<empty>"}`); }
  }
  const knownCapabilities = new Set(["vision", "function_tools", "hosted_web_search", "hosted_image_generation", "hosted_code_execution"]);
  if (config.modelCapabilities !== undefined && (!Array.isArray(config.modelCapabilities) || config.modelCapabilities.some(item => typeof item !== "string" || !knownCapabilities.has(item)) || new Set(config.modelCapabilities).size !== config.modelCapabilities.length)) throw new TypeError("modelCapabilities must contain unique supported capability names");
  const rootProtocol = config.protocol ?? "openai_responses";
  if (rootProtocol === "openai_chat_completions" && Array.isArray(config.modelCapabilities) && config.modelCapabilities.some(item => item === "hosted_web_search" || item === "hosted_image_generation" || item === "hosted_code_execution")) throw new TypeError("hosted model capabilities require openai_responses");
  if (config.profiles !== undefined) {
    if (!config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles)) throw new TypeError("profiles must be an object keyed by profile ID");
    for (const [id, value] of Object.entries(config.profiles)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new TypeError(`invalid model profile ID: ${id}`);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`profile ${id} must be an object`);
      const profile = value as Record<string, unknown>;
      if (Object.keys(profile).some(key => !["model", "protocol", "capabilities", "reasoningEffort"].includes(key))) throw new TypeError(`profile ${id} contains an unsupported field`);
      if (typeof profile.model !== "string" || !profile.model.trim()) throw new TypeError(`profile ${id}.model must be a non-empty string`);
      if (profile.protocol !== undefined && profile.protocol !== "openai_responses" && profile.protocol !== "openai_chat_completions") throw new TypeError(`profile ${id}.protocol is invalid`);
      if (profile.capabilities !== undefined && (!Array.isArray(profile.capabilities) || profile.capabilities.some(item => typeof item !== "string" || !knownCapabilities.has(item)) || new Set(profile.capabilities).size !== profile.capabilities.length)) throw new TypeError(`profile ${id}.capabilities must contain unique supported capability names`);
      if ((profile.protocol ?? rootProtocol) === "openai_chat_completions" && Array.isArray(profile.capabilities) && profile.capabilities.some(item => item === "hosted_web_search" || item === "hosted_image_generation" || item === "hosted_code_execution")) throw new TypeError(`profile ${id} hosted capabilities require openai_responses`);
      if (profile.reasoningEffort !== undefined && !["default", "low", "medium", "high", "xhigh"].includes(String(profile.reasoningEffort))) throw new TypeError(`profile ${id}.reasoningEffort is invalid`);
    }
    const routes = new Map<string, unknown>([[config.model, rootProtocol]]);
    for (const [id, value] of Object.entries(config.profiles)) { const profile = value as Record<string, unknown>; const protocol = profile.protocol ?? rootProtocol; const existing = routes.get(String(profile.model)); if (existing && existing !== protocol) throw new TypeError(`profile ${id} assigns model ${String(profile.model)} to a conflicting protocol`); routes.set(String(profile.model), protocol); }
  }
  parseDiscordTriggerPolicy(config.discord);
  validateAuthorityConfig(config.authority);
  if (config.subagent !== undefined) {
    if (!config.subagent || typeof config.subagent !== "object" || Array.isArray(config.subagent)) throw new TypeError("subagent must be an object");
    const subagent = config.subagent as Record<string, unknown>;
    if (Object.keys(subagent).some(key => key !== "maxConcurrentChildren" && key !== "maxParallelTools")) throw new TypeError("subagent contains an unsupported field");
    for (const key of ["maxConcurrentChildren", "maxParallelTools"] as const) if (subagent[key] !== undefined && (!Number.isSafeInteger(subagent[key]) || Number(subagent[key]) < 1 || Number(subagent[key]) > 2)) throw new TypeError(`subagent.${key} must be 1 or 2`);
  }
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

const HTML = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ümiro 控制台</title><style>body{font:15px system-ui;max-width:1100px;margin:30px auto;padding:0 16px;background:#111;color:#eee}button,input,select,textarea{font:inherit}input,textarea,select{box-sizing:border-box;width:100%;background:#1d1d1d;color:#eee;border:1px solid #555;padding:8px}textarea{height:360px}button{width:auto;padding:8px 14px;margin:6px 4px 6px 0}section{border:1px solid #444;padding:16px;margin:16px 0}small{color:#aaa}.files button{font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.schedule,.plugin,.approval,.run{border-top:1px solid #444;padding:8px 0}pre{white-space:pre-wrap}</style><h1>ümiro V2 控制台</h1><section><label>Web UI Token<input id="token" type="password" autocomplete="off"></label><button id="connect">連線</button><span id="state"></span><pre id="runtime"></pre><h3>Secrets 狀態</h3><pre id="secrets"></pre></section><section><h2>最近 Runs</h2><button id="refreshRuns">重新整理</button><div id="runs"></div><pre id="runDetail"></pre></section><section><h2>待核准操作</h2><button id="refreshApprovals">重新整理</button><div id="approvals"></div></section><section><h2>設定</h2><h3>API 可用模型</h3><pre id="models"></pre><div id="help"></div><textarea id="config"></textarea><button id="saveConfig">儲存設定</button><small>標示需重啟的設定會在下次 daemon 啟動生效。</small></section><section><h2>Agent Workspace</h2><div class="files" id="files"></div><h3 id="filename">尚未選擇檔案</h3><textarea id="document"></textarea><button id="saveDocument">儲存文件</button></section><section><h2>Cron／Reminder</h2><div class="grid"><input id="scheduleName" placeholder="名稱"><select id="scheduleKind"><option value="cron">Cron</option><option value="once">一次性 Reminder</option></select><input id="scheduleWhen" placeholder="cron expression 或 ISO 時間"><input id="scheduleTimezone" value="Asia/Taipei" placeholder="Timezone"><input id="scheduleChannel" placeholder="Discord channel ID（可留空）"></div><textarea id="schedulePrompt" placeholder="Agent prompt" style="height:100px"></textarea><button id="createSchedule">建立</button><button id="refreshSchedules">重新整理</button><div id="schedules"></div></section><section><h2>內掛／外掛</h2><input id="pluginSource" placeholder="外掛 GitHub HTTPS URL 或本機路徑"><input id="pluginWorkspace" placeholder="monorepo workspace（可留空）"><button id="installPlugin">安裝外掛</button><button id="refreshPlugins">重新整理</button><small>內掛隨 ümiro 出貨，可停用但不可移除；外掛由使用者安裝，可獨立更新與移除。兩者都走相同 Plugin runtime。變更在重啟 daemon 後完整生效。</small><div id="plugins"></div></section><script src="app.js"></script></html>`;
const JS = `
const $=id=>document.getElementById(id);let file;let editingSchedule;
const headers=()=>({'authorization':'Bearer '+$('token').value,'content-type':'application/json'});
const diagnostics=document.createElement('section');diagnostics.innerHTML='<h2>Usage／Logs</h2><button id="refreshUsage">重新整理 Usage</button><button id="refreshLogs">重新整理 Logs</button><pre id="usage"></pre><pre id="logs"></pre>';document.body.insertBefore(diagnostics,document.body.lastElementChild);
const baseUrl=new URL('.',location.href);
async function api(path,options={}){const target=new URL(String(path).replace(/^\\/+/,''),baseUrl);const r=await fetch(target,{...options,headers:{...headers(),...(options.headers||{})}});const data=await r.json();if(!r.ok)throw new Error(data.error||r.statusText);return data}
async function usage(){$('usage').textContent=JSON.stringify(await api('/api/usage'),null,2)}
async function logs(){$('logs').textContent=JSON.stringify(await api('/api/logs?limit=100'),null,2)}
async function schedules(){const items=await api('/api/schedules');$('schedules').replaceChildren(...items.map(x=>{const d=document.createElement('div');d.className='schedule';const label=document.createElement('span');label.textContent=x.name+' — '+JSON.stringify(x.schedule)+' — '+(x.enabled?'啟用':'停用');const toggle=document.createElement('button');toggle.textContent=x.enabled?'停用':'啟用';toggle.onclick=()=>api('/api/schedules/'+encodeURIComponent(x.id),{method:'PATCH',body:JSON.stringify({enabled:!x.enabled})}).then(schedules);const edit=document.createElement('button');edit.textContent='編輯';edit.onclick=()=>{editingSchedule=x.id;$('scheduleName').value=x.name;$('scheduleKind').value=x.schedule.kind;$('scheduleWhen').value=x.schedule.kind==='cron'?x.schedule.expression:x.schedule.at;$('scheduleTimezone').value=x.timezone;$('schedulePrompt').value=x.input?.prompt||'';$('scheduleChannel').value=x.destination?.channelId||'';$('createSchedule').textContent='儲存修改'};const remove=document.createElement('button');remove.textContent='刪除';remove.onclick=()=>confirm('確定刪除？')&&api('/api/schedules/'+encodeURIComponent(x.id),{method:'DELETE'}).then(schedules);d.append(label,toggle,edit,remove);return d}))}
async function pluginAction(action,source,workspace,config){await api('/api/plugins/action',{method:'POST',body:JSON.stringify({action,source,workspace,config})});await plugins()}
async function plugins(){const items=await api('/api/plugins');$('plugins').replaceChildren(...items.map(x=>{const d=document.createElement('div');d.className='plugin';const builtin=x.source.startsWith('builtin:');const label=document.createElement('span');label.textContent=(builtin?'內掛':'外掛')+' — '+(x.enabled?'啟用':'停用')+' — '+x.source;const toggle=document.createElement('button');toggle.textContent=x.enabled?'停用':'啟用';toggle.onclick=()=>pluginAction(x.enabled?'disable':'enable',x.source,x.workspace);const configure=document.createElement('button');configure.textContent='設定';configure.onclick=()=>{const value=prompt('JSON config',JSON.stringify(x.config||{},null,2));if(value!==null)pluginAction('configure',x.source,x.workspace,JSON.parse(value)).catch(e=>alert(e.message))};d.append(label,toggle,configure);if(!builtin){const update=document.createElement('button');update.textContent='更新';update.onclick=()=>pluginAction('update',x.source,x.workspace).catch(e=>alert(e.message));const remove=document.createElement('button');remove.textContent='移除';remove.onclick=()=>confirm('確定移除？')&&pluginAction('remove',x.source,x.workspace).catch(e=>alert(e.message));d.append(update,remove)}return d}))}
async function approvals(){const items=await api('/api/approvals');$('approvals').replaceChildren(...items.map(x=>{const d=document.createElement('div');d.className='approval';const label=document.createElement('pre');label.textContent=x.operation+'\\n到期：'+x.expiresAt+'\\n'+x.details;const approve=document.createElement('button');approve.textContent='核准';approve.onclick=()=>api('/api/approvals/'+encodeURIComponent(x.id),{method:'POST',body:JSON.stringify({action:'approve'})}).then(approvals).catch(e=>alert(e.message));const deny=document.createElement('button');deny.textContent='拒絕';deny.onclick=()=>api('/api/approvals/'+encodeURIComponent(x.id),{method:'POST',body:JSON.stringify({action:'deny'})}).then(approvals).catch(e=>alert(e.message));d.append(label,approve,deny);return d}))}
async function runs(){const items=await api('/api/runs?limit=30');$('runs').replaceChildren(...items.map(x=>{const d=document.createElement('div');d.className='run';const b=document.createElement('button');b.textContent=x.id;const label=document.createElement('span');label.textContent=x.state+' — '+x.origin+' — '+x.updatedAt+(x.usage?' — '+x.usage.inputTokens+' in / '+x.usage.outputTokens+' out':'');b.onclick=async()=>{$('runDetail').textContent=JSON.stringify(await api('/api/runs/'+encodeURIComponent(x.id)),null,2)};d.append(b,label);return d}))}
async function connect(){localStorage.umiroToken=$('token').value;const [schema,config,runtime,secrets,names,models]=await Promise.all([api('/api/schema'),api('/api/config'),api('/api/runtime'),api('/api/secrets'),api('/api/workspace'),api('/api/models').catch(e=>['模型探索失敗：'+e.message])]);$('help').innerHTML=Object.values(schema).map(x=>'<p><b>'+x.label+'</b> — '+x.description+'<br><small>預設：'+JSON.stringify(x.defaultValue)+'；風險：'+x.risk+(x.restartRequired?'；需重啟':'；即時生效')+'</small></p>').join('');$('config').value=JSON.stringify(config,null,2);$('runtime').textContent=JSON.stringify(runtime,null,2);$('secrets').textContent=Object.entries(secrets).map(([name,set])=>name+'：'+(set?'已設定':'未設定')).join('\\n');$('models').textContent=models.join('\\n');$('files').replaceChildren(...names.map(n=>{const b=document.createElement('button');b.textContent=n;b.onclick=()=>load(n).catch(e=>alert(e.message));return b}));await Promise.all([runs(),schedules(),plugins(),approvals(),usage(),logs()]);$('state').textContent='已連線'}
async function load(name){const x=await api('/api/workspace/'+name);file=name;$('filename').textContent=name;$('document').value=x.content}
$('connect').onclick=()=>connect().catch(e=>$('state').textContent=e.message);
$('saveConfig').onclick=()=>api('/api/config',{method:'PUT',body:$('config').value}).then(()=>alert('已儲存')).catch(e=>alert(e.message));
$('saveDocument').onclick=()=>file?api('/api/workspace/'+file,{method:'PUT',body:JSON.stringify({content:$('document').value})}).then(()=>alert('已儲存')).catch(e=>alert(e.message)):alert('請先選檔案');
$('refreshSchedules').onclick=()=>schedules().catch(e=>alert(e.message));
$('createSchedule').onclick=()=>{const kind=$('scheduleKind').value;const when=$('scheduleWhen').value;const body={name:$('scheduleName').value,kind,expression:kind==='cron'?when:undefined,at:kind==='once'?when:undefined,timezone:$('scheduleTimezone').value,prompt:$('schedulePrompt').value,channelId:$('scheduleChannel').value||undefined};const path=editingSchedule?'/api/schedules/'+encodeURIComponent(editingSchedule):'/api/schedules';api(path,{method:editingSchedule?'PATCH':'POST',body:JSON.stringify(body)}).then(()=>{editingSchedule=undefined;$('createSchedule').textContent='建立';return schedules()}).catch(e=>alert(e.message))};
$('refreshPlugins').onclick=()=>plugins().catch(e=>alert(e.message));
$('installPlugin').onclick=()=>pluginAction('install',$('pluginSource').value,$('pluginWorkspace').value||undefined).catch(e=>alert(e.message));
$('refreshApprovals').onclick=()=>approvals().catch(e=>alert(e.message));
$('refreshRuns').onclick=()=>runs().catch(e=>alert(e.message));
$('refreshUsage').onclick=()=>usage().catch(e=>alert(e.message));
$('refreshLogs').onclick=()=>logs().catch(e=>alert(e.message));
$('token').value=localStorage.umiroToken||'';
`;

export class ControlPanelServer {
  private server: Server | undefined;
  constructor(private readonly options: ControlPanelOptions) { if (options.host !== "127.0.0.1" && options.host !== "::1") throw new TypeError("control panel must bind to loopback"); if (!options.token) throw new TypeError("control panel token is required"); }
  async start(): Promise<void> { if (this.server) return; this.server = createServer((request, response) => void this.handle(request, response)); await new Promise<void>((resolveReady, reject) => { this.server!.once("error", reject); this.server!.listen(this.options.port, this.options.host, resolveReady); }); }
  async stop(): Promise<void> { const server = this.server; this.server = undefined; if (server) await new Promise<void>((resolveDone, reject) => server.close(error => error ? reject(error) : resolveDone())); }
  port(): number | undefined { const address = this.server?.address(); return address && typeof address === "object" ? address.port : undefined; }
  private authorized(request: IncomingMessage): boolean { const value = request.headers.authorization; return typeof value === "string" && value.startsWith("Bearer ") && secureEqual(value.slice(7), this.options.token); }
  private editableFiles(): ReadonlySet<string> { return new Set((this.options.workspaceFiles ?? BASE_EDITABLE_FILES).filter(name => KNOWN_EDITABLE_FILES.has(name))); }
  private audit(event: string, data: Readonly<Record<string, string | number | boolean>>): void { try { this.options.audit?.(event, data); } catch { /* observability cannot alter a completed control action */ } }
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
      if (request.method === "GET" && url.pathname === "/api/secrets") return json(response, 200, this.options.secrets?.() ?? {});
      if (request.method === "GET" && url.pathname === "/api/models") { if (!this.options.models) return json(response, 503, { error: "model catalog unavailable" }); return json(response, 200, await this.options.models()); }
      if (request.method === "GET" && url.pathname === "/api/workspace") return json(response, 200, [...this.editableFiles()]);
      if (request.method === "PUT" && url.pathname === "/api/config") { const config = validateControlConfig(await body(request)); await atomicWrite(this.options.configFile, `${JSON.stringify(config, null, 2)}\n`); this.audit("control.config.saved", { fieldCount: Object.keys(config).length, restartRequired: true }); return json(response, 200, { saved: true, restartRequired: true }); }
      if (request.method === "GET" && url.pathname === "/api/schedules") { if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); return json(response, 200, await this.options.schedules.list()); }
      if (request.method === "POST" && url.pathname === "/api/schedules") {
        if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); const input = await body(request) as Record<string, unknown>;
        if (typeof input.name !== "string" || !input.name.trim() || (input.kind !== "cron" && input.kind !== "once") || typeof input.timezone !== "string" || !input.timezone || typeof input.prompt !== "string" || !input.prompt.trim()) throw new TypeError("name, kind, timezone and prompt are required");
        if (input.kind === "cron" && typeof input.expression !== "string") throw new TypeError("cron expression is required"); if (input.kind === "once" && typeof input.at !== "string") throw new TypeError("reminder time is required");
        const created = await this.options.schedules.create({ name: input.name.trim(), kind: input.kind, ...(input.kind === "cron" ? { expression: input.expression as string } : { at: input.at as string }), timezone: input.timezone, prompt: input.prompt, ...(typeof input.channelId === "string" && input.channelId ? { channelId: input.channelId } : {}) }); this.audit("control.schedule.created", { kind: input.kind }); return json(response, 201, created);
      }
      const scheduleMatch = /^\/api\/schedules\/([A-Za-z0-9._:-]{1,160})$/.exec(url.pathname); const scheduleId = scheduleMatch?.[1];
      if (scheduleId && request.method === "PATCH") { if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); const input = await body(request) as Record<string, unknown>; if (typeof input.enabled === "boolean" && Object.keys(input).length === 1) { const changed = await this.options.schedules.setEnabled(scheduleId, input.enabled); this.audit("control.schedule.toggled", { scheduleId, enabled: input.enabled }); return json(response, 200, changed); } if (!this.options.schedules.update) return json(response, 503, { error: "schedule editing unavailable" }); if (typeof input.name !== "string" || !input.name.trim() || (input.kind !== "cron" && input.kind !== "once") || typeof input.timezone !== "string" || !input.timezone || typeof input.prompt !== "string" || !input.prompt.trim()) throw new TypeError("name, kind, timezone and prompt are required"); if (input.kind === "cron" && typeof input.expression !== "string") throw new TypeError("cron expression is required"); if (input.kind === "once" && typeof input.at !== "string") throw new TypeError("reminder time is required"); const changed = await this.options.schedules.update(scheduleId, { name: input.name.trim(), kind: input.kind, ...(input.kind === "cron" ? { expression: input.expression as string } : { at: input.at as string }), timezone: input.timezone, prompt: input.prompt, ...(typeof input.channelId === "string" && input.channelId ? { channelId: input.channelId } : {}) }); this.audit("control.schedule.updated", { scheduleId, kind: input.kind }); return json(response, 200, changed); }
      if (scheduleId && request.method === "DELETE") { if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); const removed = await this.options.schedules.remove(scheduleId); this.audit("control.schedule.removed", { scheduleId, removed }); return json(response, 200, { removed }); }
      if (request.method === "GET" && url.pathname === "/api/plugins") { if (!this.options.plugins) return json(response, 503, { error: "plugin manager unavailable" }); return json(response, 200, await this.options.plugins.list()); }
      if (request.method === "POST" && url.pathname === "/api/plugins/action") {
        if (!this.options.plugins) return json(response, 503, { error: "plugin manager unavailable" }); const input = await body(request) as Record<string, unknown>;
        if (input.action !== "install" && input.action !== "configure" && input.action !== "enable" && input.action !== "disable" && input.action !== "update" && input.action !== "remove") throw new TypeError("unsupported plugin action");
        if (typeof input.source !== "string" || !input.source.trim()) throw new TypeError("plugin source is required");
        if (input.config !== undefined && (!input.config || typeof input.config !== "object" || Array.isArray(input.config))) throw new TypeError("plugin config must be an object");
        const result = await this.options.plugins.run(input.action, input.source, typeof input.workspace === "string" && input.workspace ? input.workspace : undefined, input.config as Record<string, unknown> | undefined); this.audit("control.plugin.action", { action: input.action }); return json(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/runtime") return json(response, 200, this.options.runtime ? await this.options.runtime() : { status: "running" });
      if (request.method === "GET" && url.pathname === "/api/logs") { if (!this.options.logs) return json(response, 503, { error: "log view unavailable" }); const raw = url.searchParams.get("limit") ?? "100"; if (!/^\d{1,3}$/.test(raw)) throw new TypeError("log limit must be an integer"); const limit = Number(raw); if (limit < 1 || limit > 500) throw new TypeError("log limit must be between 1 and 500"); return json(response, 200, await this.options.logs(limit)); }
      if (request.method === "GET" && url.pathname === "/api/usage") { if (!this.options.usage) return json(response, 503, { error: "usage view unavailable" }); return json(response, 200, await this.options.usage()); }
      if (request.method === "GET" && url.pathname === "/api/runs") { if (!this.options.runs) return json(response, 503, { error: "run query unavailable" }); const raw = url.searchParams.get("limit") ?? "50"; if (!/^\d{1,3}$/.test(raw)) throw new TypeError("run limit must be an integer"); const limit = Number(raw); if (limit < 1 || limit > 200) throw new TypeError("run limit must be between 1 and 200"); return json(response, 200, await this.options.runs.list(limit)); }
      const runMatch = /^\/api\/runs\/([A-Za-z0-9._:-]{1,160})$/.exec(url.pathname); const runId = runMatch?.[1];
      if (request.method === "GET" && runId) { if (!this.options.runs) return json(response, 503, { error: "run query unavailable" }); const result = await this.options.runs.get(runId); return result === undefined ? json(response, 404, { error: "run not found" }) : json(response, 200, result); }
      if (request.method === "GET" && url.pathname === "/api/approvals") { if (!this.options.approvals) return json(response, 503, { error: "approval service unavailable" }); return json(response, 200, await this.options.approvals.list()); }
      const approvalMatch = /^\/api\/approvals\/([A-Za-z0-9._-]{1,64})$/.exec(url.pathname); const approvalId = approvalMatch?.[1];
      if (approvalId && request.method === "POST") { if (!this.options.approvals) return json(response, 503, { error: "approval service unavailable" }); const input = await body(request) as { action?: unknown }; if (input.action !== "approve" && input.action !== "deny") throw new TypeError("approval action must be approve or deny"); const result = await this.options.approvals.resolve(approvalId, input.action); this.audit("control.approval.resolved", { approvalId, action: input.action }); return json(response, 200, result); }
      const match = /^\/api\/workspace\/([A-Z]+\.md)$/.exec(url.pathname); const name = match?.[1];
      if (name && this.editableFiles().has(name)) {
        const path = join(this.options.workspace, name);
        if (request.method === "GET") return json(response, 200, { name, content: await readFile(path, "utf8") });
        if (request.method === "PUT") { const input = await body(request) as { content?: unknown }; if (typeof input.content !== "string") throw new TypeError("content must be a string"); await atomicWrite(path, input.content); this.audit("control.workspace.saved", { name, bytes: Buffer.byteLength(input.content) }); return json(response, 200, { saved: true }); }
      }
      return json(response, 404, { error: "not found" });
    } catch (error) { return json(response, error instanceof RangeError ? 413 : error instanceof SyntaxError || error instanceof TypeError ? 400 : 500, { error: error instanceof Error ? error.message : "request failed" }); }
  }
}
