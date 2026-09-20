import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { parseDiscordTriggerPolicy } from "@umiro/adapter-discord";
import { validateAuthorityConfig } from "./authority-config.js";
import { validateEmbeddingConfig } from "./embedding-config.js";
import { assertConfigContainsNoSecrets } from "@umiro/core/config";
import { assertUserManagedSchedule, type ControlPanelScheduleView } from "./control-panel-schedules.js";

const HTML = readFileSync(new URL("./control-panel/index.html", import.meta.url), "utf8");
const JS = readFileSync(new URL("./control-panel/app.js", import.meta.url), "utf8");
const THEME_JS = readFileSync(new URL("./control-panel/theme.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("./control-panel/app.css", import.meta.url), "utf8");
const FAVICON = readFileSync(new URL("./control-panel/favicon.png", import.meta.url));

const BASE_EDITABLE_FILES = ["SOUL.md", "AGENT.md", "OWNER.md", "memory/PREFERENCES.md", "memory/LESSONS.md", "memory/WORKFLOWS.md", "memory/ONGOING.md", "memory/FACTS.md"] as const;
const KNOWN_EDITABLE_FILES = new Set([...BASE_EDITABLE_FILES, "PEOPLE.md"]);
const MAX_BODY = 1024 * 1024;

export interface ControlPanelSchedules {
  list(): Promise<readonly ControlPanelScheduleView[]>;
  create(input: { readonly name: string; readonly kind: "cron" | "once"; readonly expression?: string; readonly at?: string; readonly timezone: string; readonly prompt: string; readonly channelId?: string }): Promise<unknown>;
  setEnabled(id: string, enabled: boolean): Promise<unknown>;
  update(id: string, input: { readonly name: string; readonly kind: "cron" | "once"; readonly expression?: string; readonly at?: string; readonly timezone: string; readonly prompt: string; readonly channelId?: string }): Promise<unknown>;
  remove(id: string): Promise<boolean>;
  preview?(input: { readonly kind: "cron" | "once"; readonly expression?: string; readonly at?: string; readonly timezone: string }): Promise<string | null> | string | null;
}
export interface ControlPanelPlugins { list(): Promise<unknown>; run(action: "install" | "configure" | "enable" | "disable" | "update" | "remove", source: string, workspace?: string, config?: Record<string, unknown>, removeSecrets?: boolean): Promise<unknown> }
export interface ControlPanelRuns { list(limit: number): Promise<unknown>; get(id: string): Promise<unknown | undefined> }
export interface ControlPanelChannels {
  list(): Promise<unknown>;
  untrack(externalId: string): Promise<{ readonly tracked: boolean; readonly archivedConversationId?: string }>;
}
export interface ControlPanelConversations {
  list(filter: { readonly scope?: { readonly transport: string; readonly externalId: string }; readonly state?: "active" | "archived"; readonly limit: number }): Promise<unknown>;
  messages(conversationId: string, limit: number, after?: number): Promise<unknown | undefined>;
}
export interface GatewayReadiness {
  readonly storage: boolean;
  readonly plugins: boolean;
  readonly discord: boolean;
  readonly scheduler: boolean;
  readonly configurationRequired?: readonly string[];
  readonly shuttingDown?: boolean;
}
export interface ConfigApplyResult { readonly applied: readonly string[]; readonly restartRequired: readonly string[] }
export interface ControlPanelOptions { readonly host: string; readonly port: number; readonly token: string; readonly configFile: string; readonly workspace: string; readonly workspaceFiles?: readonly string[]; readonly secrets?: () => Readonly<Record<string, boolean>>; readonly publicSecrets?: () => Readonly<Record<string, string>>; readonly updateSecrets?: (secrets: Readonly<Record<string, string>>) => Promise<ConfigApplyResult>; readonly models?: (connection?: { readonly baseUrl: string; readonly apiKey?: string }) => Promise<readonly string[]>; readonly applyConfig?: (config: Record<string, unknown>) => Promise<ConfigApplyResult>; readonly audit?: (event: string, data: Readonly<Record<string, string | number | boolean>>) => void; readonly schedules?: ControlPanelSchedules; readonly plugins?: ControlPanelPlugins; readonly runs?: ControlPanelRuns; readonly channels?: ControlPanelChannels; readonly conversations?: ControlPanelConversations; readonly logs?: (limit: number) => Promise<unknown> | unknown; readonly usage?: () => Promise<unknown> | unknown; readonly runtime?: () => Promise<unknown> | unknown; readonly readiness?: () => Promise<GatewayReadiness> | GatewayReadiness; readonly restart?: () => Promise<void> | void; readonly processId?: number }

export const CONFIG_EXPLANATIONS = {
  model: { label: "主要模型", description: "Discord 對話與未指定模型的 Run 使用的模型 ID。", defaultValue: null, risk: "模型必須存在於目前 API；錯誤值會使 Run 失敗。", restartRequired: false },
  protocol: { label: "模型 API protocol", description: "主要模型使用 OpenAI Responses 或 Chat Completions adapter。", defaultValue: "openai_responses", risk: "hosted web search／生圖只能搭配 Responses；同一 model ID 不可由不同 profile 指向不同 protocol。", restartRequired: false },
  profiles: { label: "模型 profiles", description: "依 profile ID 定義模型、能力與預設 reasoning；Discord session 的模型選擇會解析這些 profile。", defaultValue: {}, risk: "模型 profile 設定錯誤會使指定的 session 或 Run 失敗。", restartRequired: false },
  modelCapabilities: { label: "模型能力", description: "模型明確支援的能力清單，例如 vision、function_tools、hosted_web_search。", defaultValue: [], risk: "未宣告會 fail closed，模型無法使用未列出的能力。", restartRequired: true },
  contextMaxTokens: { label: "Context token 上限", description: "固定文件、人物、記憶與對話歷史合計可使用的估算 token 上限。", defaultValue: 24000, risk: "過高會增加延遲與費用，過低可能放不下必要 context。", restartRequired: false },
  skills: { label: "Workspace skills", description: "啟用 workspace/skills/<name>/SKILL.md 的技能摘要；技能正文仍由模型按需讀取。", defaultValue: [], risk: "技能檔是使用者提供的內容，會影響模型的工作流程；只啟用信任的目錄。", restartRequired: true },
  pricing: { label: "模型價格", description: "依 model ID 設定 inputUsdPerMillion／outputUsdPerMillion；未設定的模型不猜測成本。", defaultValue: {}, risk: "只影響估算；錯誤價格會造成控制台成本顯示不準。", restartRequired: false },
  "embedding.provider": { label: "Embedding provider", description: "disabled、gemini 或 openai-compatible；disabled 時只用 FTS。", defaultValue: "disabled", risk: "啟用後會把可索引文字送往所選 provider。", restartRequired: true },
  "embedding.model": { label: "Embedding model", description: "啟用 embedding 時使用的模型 ID，不可寫死為內建模型。", defaultValue: null, risk: "更換模型或維度會觸發 projection 重建。", restartRequired: true },
  "embedding.separateQueryModel": { label: "分離 Query 向量模型", description: "只有 provider 官方保證文件模型與 Query 模型共享向量空間時才能啟用；相同維度不等於向量相容。Voyage 4 與 voyage-4-lite 是一個可研究的例子，但不限定 provider。", defaultValue: false, risk: "錯誤分離會讓語意搜尋結果失真；必須使用 provider 保證相容的模型組合。", restartRequired: true },
  "embedding.separationWarning": { label: "分離模型警告", description: "只有 provider 官方保證兩個模型共享向量空間時才能分離；相同維度不等於向量相容。", defaultValue: null, risk: "請先確認 provider 的向量空間保證。", restartRequired: false },
  "embedding.queryModel": { label: "Query 向量模型", description: "只在分離模式使用的查詢模型；必須與文件模型共享同一向量空間。", defaultValue: null, risk: "查詢模型不相容會使 recall 失真。", restartRequired: true },
  "embedding.dimensions": { label: "共用向量維度", description: "文件與 Query request 都會固定要求的向量維度，範圍 1–65536。", defaultValue: null, risk: "provider 回傳不同維度時該向量會被拒絕。", restartRequired: true },
  "embedding.baseUrl": { label: "Embedding API URL", description: "OpenAI-compatible embedding endpoint；與 API key 一起儲存在 secrets.env。", defaultValue: null, risk: "內容會傳送到此 endpoint；只能使用信任的服務。", restartRequired: true },
  "embedding.apiKey": { label: "Embedding API Key", description: "Embedding provider 的密鑰；只寫入 secrets.env，不會回傳已設定值。", defaultValue: null, risk: "這是 provider 憑證，只應填入信任的服務。", restartRequired: true },
  "embedding.recallLimit": { label: "跨對話記憶筆數", description: "每輪自動注入最多幾筆其他 Conversation 的向量搜尋結果。", defaultValue: 5, risk: "調高會佔用更多 context，也可能引入不相關記憶。", restartRequired: false },
  "embedding.minSimilarity": { label: "跨對話記憶門檻", description: "0–1 的向量相似度下限；不同 provider／model 的分數分佈不同，可依實際 recall 調整。", defaultValue: 0.55, risk: "調低會提高 recall，但可能注入不相關資料；調高可能漏掉應記得的對話。", restartRequired: false },
  "embedding.requestsPerMinute": { label: "Embedding 每分鐘請求上限", description: "背景建索引、自動 recall 與手動搜尋共用的 provider RPM；前景查詢會優先於等待中的背景工作。省略表示不由 ümiro 限速。", defaultValue: null, risk: "設得高於帳號額度會收到 rate limit；設得過低會延後背景索引。", restartRequired: true },
  "discord.ignoredChannels": { label: "完全忽略頻道", description: "不記錄、不回覆；精確比對 channel/thread ID，優先級最高。", defaultValue: [], risk: "列入後該頻道的訊息完全不進入記憶。", restartRequired: false },
  "discord.ambientChannels": { label: "Ambient 頻道", description: "不需 mention 即觸發；仍必須通過 guild/channel scope。", defaultValue: [], risk: "會提高觸發頻率、模型用量與誤回覆機率。", restartRequired: false },
  "discord.allowedChannels": { label: "允許頻道", description: "所有人（包含 Owner）在伺服器內可使用的 channel/thread ID；空陣列表示不以此項限制。", defaultValue: [], risk: "空陣列不代表拒絕全部；需配合 allowedGuilds 理解範圍。", restartRequired: false },
  "discord.allowedGuilds": { label: "允許伺服器", description: "所有人（包含 Owner）可使用的 guild ID；空陣列表示不以此項限制。", defaultValue: [], risk: "設定錯誤會讓 bot 在非預期 guild 回應或完全無法使用。", restartRequired: false },
  "discord.respondToBots": { label: "回應其他 Bot", description: "是否允許其他 bot 觸發；自己的訊息永遠忽略以避免迴圈。", defaultValue: true, risk: "可能被其他 bot 的訊息觸發並增加用量。", restartRequired: false },
  "discord.queueMode": { label: "預設訊息模式", description: "queue 會等目前 Run 完成再處理；steer 會把同 session 的新訊息併入目前 Run 的下一個安全邊界。", defaultValue: "queue", risk: "steer 會讓群聊中合格的新訊息改變正在執行的 Run。", restartRequired: false },
  "discord.presence.status": { label: "Discord 狀態", description: "Bot 顯示為 online、idle、dnd 或 invisible。", defaultValue: "online", risk: "僅影響顯示狀態。", restartRequired: false },
  "discord.presence.activity": { label: "Discord 活動文字", description: "Bot 名稱下方顯示的活動文字。", defaultValue: "with ümiro", risk: "所有能看到 bot 的 Discord 使用者都能看到。", restartRequired: false },
  "authority.owner": { label: "Owner 權限", description: "Owner 的 capability、可見範圍與 instruction authority；省略時取得目前安裝能力的完整權限。", defaultValue: { visibility: { kind: "all" }, instructionAuthority: "full" }, risk: "縮小會限制 Owner；列入未安裝 capability 會讓 daemon 拒絕啟動。", restartRequired: true },
  "authority.member": { label: "一般成員權限", description: "一般成員可用的 capability 與 restricted 可見範圍；預設只開放聊天所需的 11 類能力。", defaultValue: { visibility: { kind: "restricted" }, instructionAuthority: "scoped" }, risk: "擴大 capability 或 resource visibility 會讓群組成員操作更多資料與服務。", restartRequired: true },
  "subagent.maxConcurrentChildren": { label: "每人並行下屬上限", description: "每個 Principal 同時 active 的 Child Run 數；超過直接拒絕，不排隊。", defaultValue: 2, risk: "提高並行數會同步提高模型成本；目前架構硬上限為 2。", restartRequired: false },
  "subagent.maxParallelTools": { label: "單輪並行工具上限", description: "同一 model turn 連續 parallel-safe tools 的最大並行數。", defaultValue: 2, risk: "只應用於明確宣告 parallel-safe 的工具；目前硬上限為 2。", restartRequired: false },
  "conversation.autoArchive.enabled": { label: "對話自動封存", description: "每天在指定時間封存 Discord 頻道、Thread／Forum post 與私訊的目前 conversation；關閉時不會還原已封存資料。", defaultValue: false, risk: "封存會讓下一則訊息開始新的 conversation，但歷史仍保留且可供 recall。", restartRequired: false },
  "conversation.autoArchive.time": { label: "封存時間", description: "每日執行對話自動封存的當地時間，使用 24 小時制 HH:mm。執行中的 Run 會在完成後補封存。", defaultValue: "00:00", risk: "時間設定會影響每天何時切換對話上下文。", restartRequired: false },
  "conversation.autoArchive.timezone": { label: "封存時區", description: "封存時間使用的 IANA timezone，例如 Asia/Taipei；Docker 環境請明確設定，避免使用 UTC。", defaultValue: "UTC", risk: "錯誤時區會讓封存發生在非預期時間。", restartRequired: false },
  "conversation.autoArchive.explanation": { label: "功能說明", description: "每天指定時間後封存各 Discord 頻道、Thread／Forum post 與私訊目前的 conversation；下一則訊息會開始新的 conversation。封存不等於刪除，歷史仍可瀏覽與 semantic recall，model、reasoning、queue 等 scope preferences 不會重設。執行中的 Run 會在完成後補封存；關閉只停止未來排程，/new 仍可手動提早封存。", defaultValue: null, risk: "請確認時間與 timezone 符合你的部署環境。", restartRequired: false },
  "plugins[].path": { label: "外掛路徑", description: "由 config 直接載入的外掛位置；一般操作建議使用外掛管理介面。", defaultValue: [], risk: "外掛是 trusted in-process code，只能安裝信任的來源。", restartRequired: true },
  "plugins[].config": { label: "外掛設定", description: "傳給該外掛 manifest schema 驗證的非秘密設定。", defaultValue: {}, risk: "設定仍受 manifest schema 與 secrets 分離規則限制。", restartRequired: true },
  "webUi.enabled": { label: "Web UI 啟用", description: "是否啟動本機管理介面。", defaultValue: false, risk: "啟用後需妥善保管獨立 Web UI token。", restartRequired: true },
  "webUi.host": { label: "Web UI host", description: "只接受 127.0.0.1 或 ::1，不可直接公開到網路。", defaultValue: "127.0.0.1", risk: "公開綁定會暴露管理面，因此 validator 直接拒絕。", restartRequired: true },
  "webUi.port": { label: "Web UI port", description: "本機 HTTP port，範圍 1–65535。", defaultValue: 3210, risk: "port 衝突會使控制台啟動失敗。", restartRequired: true },
} as const;

function secureEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
const SECURITY_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" } as const;
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
  const config = value as Record<string, unknown>; const allowed = new Set(["model", "protocol", "modelCapabilities", "profiles", "contextMaxTokens", "pricing", "embedding", "skills", "discord", "authority", "subagent", "plugins", "webUi", "conversation"]);
  const unknown = Object.keys(config).find(key => !allowed.has(key)); if (unknown) throw new TypeError(`unsupported config field: ${unknown}`);
  if (typeof config.model !== "string" || !config.model.trim()) throw new TypeError("model must be a non-empty string");
  if (config.protocol !== undefined && config.protocol !== "openai_responses" && config.protocol !== "openai_chat_completions") throw new TypeError("protocol must be openai_responses or openai_chat_completions");
  if (config.contextMaxTokens !== undefined && (!Number.isSafeInteger(config.contextMaxTokens) || Number(config.contextMaxTokens) < 256 || Number(config.contextMaxTokens) > 1_000_000)) throw new TypeError("contextMaxTokens must be between 256 and 1000000");
  if (config.skills !== undefined && (!Array.isArray(config.skills) || config.skills.some(item => typeof item !== "string" || !/^[A-Za-z0-9._-]+$/.test(item)) || new Set(config.skills).size !== config.skills.length)) throw new TypeError("skills must contain unique workspace skill directory names");
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
  if (config.conversation !== undefined) {
    if (!config.conversation || typeof config.conversation !== "object" || Array.isArray(config.conversation)) throw new TypeError("conversation must be an object");
    const conversation = config.conversation as Record<string, unknown>;
    if (Object.keys(conversation).some(key => key !== "autoArchive")) throw new TypeError("conversation contains an unsupported field");
    if (conversation.autoArchive !== undefined) {
      if (!conversation.autoArchive || typeof conversation.autoArchive !== "object" || Array.isArray(conversation.autoArchive)) throw new TypeError("conversation.autoArchive must be an object");
      const auto = conversation.autoArchive as Record<string, unknown>;
      if (Object.keys(auto).some(key => !["enabled", "time", "timezone"].includes(key))) throw new TypeError("conversation.autoArchive contains an unsupported field");
      if (auto.enabled !== undefined && typeof auto.enabled !== "boolean") throw new TypeError("conversation.autoArchive.enabled must be boolean");
      if (auto.time !== undefined && (typeof auto.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(auto.time))) throw new TypeError("conversation.autoArchive.time must use HH:mm");
      if (auto.timezone !== undefined) {
        if (typeof auto.timezone !== "string" || !auto.timezone.trim()) throw new TypeError("conversation.autoArchive.timezone must be an IANA timezone");
        try { new Intl.DateTimeFormat("en-US", { timeZone: auto.timezone }).format(); } catch { throw new TypeError(`invalid IANA timezone: ${auto.timezone}`); }
      }
    }
  }
  if (config.embedding !== undefined) {
    if (!config.embedding || typeof config.embedding !== "object" || Array.isArray(config.embedding)) throw new TypeError("embedding must be an object");
    const embedding = config.embedding as Record<string, unknown>;
    const allowedEmbeddingFields = new Set(["provider", "model", "separateQueryModel", "queryModel", "dimensions", "recallLimit", "minSimilarity", "requestsPerMinute"]);
    const unknownEmbeddingField = Object.keys(embedding).find(key => !allowedEmbeddingFields.has(key));
    if (unknownEmbeddingField) throw new TypeError(`unsupported embedding field: ${unknownEmbeddingField}`);
    validateEmbeddingConfig(embedding);
  }
  if (config.webUi !== undefined) {
    if (!config.webUi || typeof config.webUi !== "object" || Array.isArray(config.webUi)) throw new TypeError("webUi must be an object");
    const ui = config.webUi as Record<string, unknown>;
    if (ui.enabled !== undefined && typeof ui.enabled !== "boolean") throw new TypeError("webUi.enabled must be boolean");
    if (ui.host !== undefined && ui.host !== "127.0.0.1" && ui.host !== "::1") throw new TypeError("webUi.host must be a loopback address");
    if (ui.port !== undefined && (!Number.isSafeInteger(ui.port) || Number(ui.port) < 1 || Number(ui.port) > 65535)) throw new TypeError("webUi.port must be between 1 and 65535");
  }
  const normalized = structuredClone(config);
  const normalizedConversation = normalized.conversation as Record<string, unknown> | undefined;
  const normalizedAutoArchive = normalizedConversation?.autoArchive as Record<string, unknown> | undefined;
  if (normalizedAutoArchive) {
    normalizedAutoArchive.enabled ??= false;
    normalizedAutoArchive.time ??= "00:00";
    normalizedAutoArchive.timezone ??= Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  return normalized;
}

async function atomicWrite(path: string, content: string): Promise<void> { const temporary = join(dirname(path), `.${basename(path)}-${crypto.randomUUID()}.tmp`); try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; } }

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
      if (request.method === "GET" && url.pathname === "/theme.js") return text(response, 200, THEME_JS, "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/app.css") return text(response, 200, CSS, "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/favicon.png") { response.writeHead(200, { ...SECURITY_HEADERS, "cache-control": "public, max-age=86400", "content-type": "image/png", "content-length": FAVICON.byteLength }); response.end(FAVICON); return; }
      if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "alive" });
      if (request.method === "GET" && url.pathname === "/readyz") {
        const checks = this.options.readiness ? await this.options.readiness() : { storage: true, plugins: true, discord: true, scheduler: true };
        const ready = checks.storage && checks.plugins && checks.discord && checks.scheduler && checks.shuttingDown !== true;
        const configurationRequired = !ready && checks.shuttingDown !== true && (checks.configurationRequired?.length ?? 0) > 0;
        return json(response, ready || configurationRequired ? 200 : 503, { status: ready ? "ready" : configurationRequired ? "configuration_required" : "not_ready", pid: this.options.processId ?? process.pid, checks });
      }
      if (!this.authorized(request)) return json(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && url.pathname === "/api/schema") return json(response, 200, CONFIG_EXPLANATIONS);
      if (request.method === "GET" && url.pathname === "/api/config") return json(response, 200, JSON.parse(await readFile(this.options.configFile, "utf8")));
      if (request.method === "GET" && url.pathname === "/api/secrets") return json(response, 200, { ...(this.options.secrets?.() ?? {}), ...(this.options.publicSecrets?.() ?? {}) });
      if (request.method === "PUT" && url.pathname === "/api/secrets") {
        if (!this.options.updateSecrets) return json(response, 503, { error: "secret configuration unavailable" });
        const input = await body(request) as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) throw new TypeError("at least one secret is required");
        const values: Record<string, string> = {};
        for (const [name, value] of Object.entries(input)) {
          if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(name) || typeof value !== "string" || !value.trim()) throw new TypeError("secret names and values are invalid");
          values[name] = value.trim();
        }
        const application = await this.options.updateSecrets(values);
        this.audit("control.secrets.saved", { fieldCount: Object.keys(values).length, restartRequired: application.restartRequired.length > 0, appliedCount: application.applied.length });
        return json(response, 200, { saved: true, applied: application.applied, restartRequired: application.restartRequired });
      }
      if (request.method === "GET" && url.pathname === "/api/models") { if (!this.options.models) return json(response, 503, { error: "model catalog unavailable" }); return json(response, 200, await this.options.models()); }
      if (request.method === "POST" && url.pathname === "/api/models/discover") {
        if (!this.options.models) return json(response, 503, { error: "model catalog unavailable" });
        const input = await body(request) as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "baseUrl" && key !== "apiKey")) throw new TypeError("model discovery input is invalid");
        if (typeof input.baseUrl !== "string" || !input.baseUrl.trim() || input.baseUrl.length > 2_048) throw new TypeError("model discovery baseUrl is invalid");
        let parsed: URL;
        try { parsed = new URL(input.baseUrl.trim()); } catch { throw new TypeError("model discovery baseUrl must be a valid URL"); }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("model discovery baseUrl must use http or https");
        if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 16_384)) throw new TypeError("model discovery apiKey is invalid");
        return json(response, 200, await this.options.models({ baseUrl: input.baseUrl.trim(), ...(typeof input.apiKey === "string" ? { apiKey: input.apiKey.trim() } : {}) }));
      }
      if (request.method === "GET" && url.pathname === "/api/channels") { if (!this.options.channels) return json(response, 503, { error: "Discord channel catalog unavailable" }); return json(response, 200, await this.options.channels.list()); }
      const trackingMatch = /^\/api\/channels\/([^/]+)\/tracking$/.exec(url.pathname);
      if (request.method === "DELETE" && trackingMatch) {
        if (!this.options.channels) return json(response, 503, { error: "Discord channel catalog unavailable" });
        if (url.search || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") || request.headers["transfer-encoding"] !== undefined) throw new TypeError("tracking request must not include a body or query parameters");
        let externalId: string;
        try { externalId = decodeURIComponent(trackingMatch[1]!); } catch { throw new TypeError("channel ID is invalid"); }
        if (!/^\d{2,32}$/.test(externalId)) throw new TypeError("channel ID must be a Discord snowflake");
        const result = await this.options.channels.untrack(externalId);
        this.audit("control.channel.untracked", { channelId: externalId, tracked: result.tracked, archived: result.archivedConversationId !== undefined });
        return json(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/conversations") {
        if (!this.options.conversations) return json(response, 503, { error: "conversation view unavailable" });
        const stateRaw = url.searchParams.get("state");
        if (stateRaw !== null && stateRaw !== "active" && stateRaw !== "archived") throw new TypeError("state must be active or archived");
        const limitRaw = url.searchParams.get("limit") ?? "50";
        if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 200) throw new TypeError("conversation limit must be between 1 and 200");
        const scopeRaw = url.searchParams.get("scope");
        let scope: { transport: string; externalId: string } | undefined;
        if (scopeRaw !== null) {
          const separator = scopeRaw.indexOf(":");
          if (separator < 1 || separator === scopeRaw.length - 1 || !/^[a-z][a-z0-9._-]*$/.test(scopeRaw.slice(0, separator))) throw new TypeError("scope must be <transport>:<externalId>");
          scope = { transport: scopeRaw.slice(0, separator), externalId: scopeRaw.slice(separator + 1) };
        }
        return json(response, 200, await this.options.conversations.list({ ...(scope ? { scope } : {}), ...(stateRaw ? { state: stateRaw } : {}), limit: Number(limitRaw) }));
      }
      if (request.method === "GET" && url.pathname === "/api/workspace") return json(response, 200, [...this.editableFiles()]);
      if (request.method === "PUT" && url.pathname === "/api/config") {
        const config = validateControlConfig(await body(request));
        const previous = await readFile(this.options.configFile, "utf8").catch(() => undefined);
        await atomicWrite(this.options.configFile, `${JSON.stringify(config, null, 2)}\n`);
        let application: ConfigApplyResult;
        try { application = this.options.applyConfig ? await this.options.applyConfig(config) : { applied: [], restartRequired: Object.keys(config) }; }
        catch (error) {
          if (previous !== undefined) await atomicWrite(this.options.configFile, previous).catch(() => undefined);
          throw error;
        }
        const restartRequired = application.restartRequired.length > 0; this.audit("control.config.saved", { fieldCount: Object.keys(config).length, restartRequired, appliedCount: application.applied.length }); return json(response, 200, { saved: true, applied: application.applied, restartRequired: application.restartRequired });
      }
      if (request.method === "GET" && url.pathname === "/api/schedules") { if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); return json(response, 200, await this.options.schedules.list()); }
      if (request.method === "POST" && url.pathname === "/api/schedules/preview") { if (!this.options.schedules?.preview) return json(response, 503, { error: "schedule preview unavailable" }); const input = await body(request) as Record<string, unknown>; if ((input.kind !== "cron" && input.kind !== "once") || typeof input.timezone !== "string" || !input.timezone) throw new TypeError("kind and timezone are required"); if (input.kind === "cron" && typeof input.expression !== "string") throw new TypeError("cron expression is required"); if (input.kind === "once" && typeof input.at !== "string") throw new TypeError("reminder time is required"); return json(response, 200, { nextFireAt: await this.options.schedules.preview({ kind: input.kind, ...(input.kind === "cron" ? { expression: input.expression as string } : { at: input.at as string }), timezone: input.timezone }) }); }
      if (request.method === "POST" && url.pathname === "/api/schedules") {
        if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" }); const input = await body(request) as Record<string, unknown>;
        if (typeof input.name !== "string" || !input.name.trim() || (input.kind !== "cron" && input.kind !== "once") || typeof input.timezone !== "string" || !input.timezone || typeof input.prompt !== "string" || !input.prompt.trim()) throw new TypeError("name, kind, timezone and prompt are required");
        if (input.kind === "cron" && typeof input.expression !== "string") throw new TypeError("cron expression is required"); if (input.kind === "once" && typeof input.at !== "string") throw new TypeError("reminder time is required");
        if (input.channelId !== undefined && (typeof input.channelId !== "string" || !/^[0-9]{2,32}$/.test(input.channelId))) throw new TypeError("channelId must be a Discord snowflake");
        const created = await this.options.schedules.create({ name: input.name.trim(), kind: input.kind, ...(input.kind === "cron" ? { expression: input.expression as string } : { at: input.at as string }), timezone: input.timezone, prompt: input.prompt, ...(typeof input.channelId === "string" ? { channelId: input.channelId } : {}) }); this.audit("control.schedule.created", { kind: input.kind }); return json(response, 201, created);
      }
      const scheduleMatch = /^\/api\/schedules\/([^/]+)$/.exec(url.pathname);
      let scheduleId: string | undefined;
      if (scheduleMatch) {
        try { scheduleId = decodeURIComponent(scheduleMatch[1]!); } catch { throw new TypeError("schedule ID is invalid"); }
        if (!/^[A-Za-z0-9._:-]{1,160}$/.test(scheduleId)) throw new TypeError("schedule ID is invalid");
      }
      if (scheduleId && request.method === "PATCH") {
        if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" });
        const target = (await this.options.schedules.list()).find(item => item.id === scheduleId);
        if (!target) return json(response, 404, { error: "schedule not found" });
        const input = await body(request) as Record<string, unknown>;
        if (typeof input.enabled === "boolean" && Object.keys(input).length === 1) {
          assertUserManagedSchedule(target, "toggle");
          const changed = await this.options.schedules.setEnabled(scheduleId, input.enabled);
          this.audit("control.schedule.toggled", { scheduleId, enabled: input.enabled });
          return json(response, 200, changed);
        }
        if (typeof input.name !== "string" || !input.name.trim() || (input.kind !== "cron" && input.kind !== "once") || typeof input.timezone !== "string" || !input.timezone || typeof input.prompt !== "string" || !input.prompt.trim()) throw new TypeError("name, kind, timezone and prompt are required");
        if (input.kind === "cron" && typeof input.expression !== "string") throw new TypeError("cron expression is required");
        if (input.kind === "once" && typeof input.at !== "string") throw new TypeError("reminder time is required");
        if (input.channelId !== undefined && (typeof input.channelId !== "string" || !/^[0-9]{2,32}$/.test(input.channelId))) throw new TypeError("channelId must be a Discord snowflake");
        assertUserManagedSchedule(target, "edit");
        const changed = await this.options.schedules.update(scheduleId, { name: input.name.trim(), kind: input.kind, ...(input.kind === "cron" ? { expression: input.expression as string } : { at: input.at as string }), timezone: input.timezone, prompt: input.prompt, ...(typeof input.channelId === "string" ? { channelId: input.channelId } : {}) });
        this.audit("control.schedule.updated", { scheduleId, kind: input.kind });
        return json(response, 200, changed);
      }
      if (scheduleId && request.method === "DELETE") {
        if (!this.options.schedules) return json(response, 503, { error: "scheduler unavailable" });
        const target = (await this.options.schedules.list()).find(item => item.id === scheduleId);
        if (!target) return json(response, 404, { error: "schedule not found" });
        assertUserManagedSchedule(target, "delete");
        const removed = await this.options.schedules.remove(scheduleId);
        this.audit("control.schedule.removed", { scheduleId, removed });
        return json(response, 200, { removed });
      }
      if (request.method === "GET" && url.pathname === "/api/plugins") { if (!this.options.plugins) return json(response, 503, { error: "plugin manager unavailable" }); return json(response, 200, await this.options.plugins.list()); }
      if (request.method === "POST" && url.pathname === "/api/plugins/action") {
        if (!this.options.plugins) return json(response, 503, { error: "plugin manager unavailable" }); const input = await body(request) as Record<string, unknown>;
        if (input.action !== "install" && input.action !== "configure" && input.action !== "enable" && input.action !== "disable" && input.action !== "update" && input.action !== "remove") throw new TypeError("unsupported plugin action");
        if (typeof input.source !== "string" || !input.source.trim()) throw new TypeError("plugin source is required");
        if (input.config !== undefined && (!input.config || typeof input.config !== "object" || Array.isArray(input.config))) throw new TypeError("plugin config must be an object");
        if (input.removeSecrets !== undefined && typeof input.removeSecrets !== "boolean") throw new TypeError("removeSecrets must be a boolean");
        if (input.removeSecrets === true && input.action !== "remove") throw new TypeError("removeSecrets is only valid with remove action");
        const workspace = typeof input.workspace === "string" && input.workspace ? input.workspace : undefined;
        const config = input.config as Record<string, unknown> | undefined;
        const result = input.removeSecrets === undefined || input.removeSecrets === false
          ? await this.options.plugins.run(input.action, input.source, workspace, config)
          : await this.options.plugins.run(input.action, input.source, workspace, config, true);
        this.audit("control.plugin.action", { action: input.action, ...(input.removeSecrets === true ? { removeSecrets: true } : {}) }); return json(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/runtime") return json(response, 200, this.options.runtime ? await this.options.runtime() : { status: "running" });
      if (request.method === "POST" && url.pathname === "/api/runtime/restart") {
        if (!this.options.restart) return json(response, 503, { error: "runtime restart unavailable" });
        this.audit("control.runtime.restart", {});
        await this.options.restart();
        return json(response, 202, { scheduled: true });
      }
      if (request.method === "GET" && url.pathname === "/api/logs") { if (!this.options.logs) return json(response, 503, { error: "log view unavailable" }); const raw = url.searchParams.get("limit") ?? "100"; if (!/^\d{1,3}$/.test(raw)) throw new TypeError("log limit must be an integer"); const limit = Number(raw); if (limit < 1 || limit > 500) throw new TypeError("log limit must be between 1 and 500"); return json(response, 200, await this.options.logs(limit)); }
      if (request.method === "GET" && url.pathname === "/api/usage") { if (!this.options.usage) return json(response, 503, { error: "usage view unavailable" }); return json(response, 200, await this.options.usage()); }
      if (request.method === "GET" && url.pathname === "/api/runs") { if (!this.options.runs) return json(response, 503, { error: "run query unavailable" }); const raw = url.searchParams.get("limit") ?? "50"; if (!/^\d{1,3}$/.test(raw)) throw new TypeError("run limit must be an integer"); const limit = Number(raw); if (limit < 1 || limit > 200) throw new TypeError("run limit must be between 1 and 200"); return json(response, 200, await this.options.runs.list(limit)); }
      const runMatch = /^\/api\/runs\/([A-Za-z0-9._:-]{1,160})$/.exec(url.pathname); const runId = runMatch?.[1];
      if (request.method === "GET" && runId) { if (!this.options.runs) return json(response, 503, { error: "run query unavailable" }); const result = await this.options.runs.get(runId); return result === undefined ? json(response, 404, { error: "run not found" }) : json(response, 200, result); }
      const messagesMatch = /^\/api\/conversations\/([A-Za-z0-9._:-]{1,160})\/messages$/.exec(url.pathname);
      const conversationId = messagesMatch?.[1];
      if (request.method === "GET" && conversationId) {
        if (!this.options.conversations) return json(response, 503, { error: "conversation view unavailable" });
        const limitRaw = url.searchParams.get("limit") ?? "200";
        if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 500) throw new TypeError("message limit must be between 1 and 500");
        const afterRaw = url.searchParams.get("after");
        if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(Number(afterRaw)))) throw new TypeError("after must be a non-negative integer");
        const result = await this.options.conversations.messages(conversationId, Number(limitRaw), afterRaw === null ? undefined : Number(afterRaw));
        return result === undefined ? json(response, 404, { error: "conversation not found" }) : json(response, 200, result);
      }
      const prefix = "/api/workspace/";
      const encodedName = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : undefined;
      const name = encodedName === undefined ? undefined : decodeURIComponent(encodedName);
      if (name && this.editableFiles().has(name)) {
        const path = join(this.options.workspace, name);
        if (request.method === "GET") return json(response, 200, { name, content: await readFile(path, "utf8") });
        if (request.method === "PUT") { const input = await body(request) as { content?: unknown }; if (typeof input.content !== "string") throw new TypeError("content must be a string"); await atomicWrite(path, input.content); this.audit("control.workspace.saved", { name, bytes: Buffer.byteLength(input.content) }); return json(response, 200, { saved: true }); }
      }
      return json(response, 404, { error: "not found" });
    } catch (error) { const statusCode = error instanceof Error && typeof (error as { readonly statusCode?: unknown }).statusCode === "number" ? Number((error as unknown as { readonly statusCode: number }).statusCode) : undefined; return json(response, statusCode ?? (error instanceof RangeError ? 413 : error instanceof SyntaxError || error instanceof TypeError ? 400 : 500), { error: error instanceof Error ? error.message : "request failed" }); }
  }
}
