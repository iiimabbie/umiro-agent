import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext, Script } from "node:vm";

const htmlUrl = new URL("../src/control-panel/index.html", import.meta.url);
const scriptUrl = new URL("../src/control-panel/app.js", import.meta.url);
const themeScriptUrl = new URL("../src/control-panel/theme.js", import.meta.url);
const cssUrl = new URL("../src/control-panel/app.css", import.meta.url);
const mainUrl = new URL("../../src/main.ts", import.meta.url);

test("control-panel settings use typed controls instead of one raw config textarea", async () => {
  const [html, script, themeScript, css, main] = await Promise.all([readFile(htmlUrl, "utf8"), readFile(scriptUrl, "utf8"), readFile(themeScriptUrl, "utf8"), readFile(cssUrl, "utf8"), readFile(mainUrl, "utf8")]);

  assert.match(html, /id="configForm"/);
  assert.doesNotMatch(html, /id="config-secrets"|id="secretForm"|id="saveSecrets"/);
  assert.doesNotMatch(html, /<textarea id="config"/);
  assert.doesNotMatch(html, /查看 API 可用模型/);
  assert.doesNotThrow(() => new Script(script));
  assert.doesNotThrow(() => new Script(themeScript));
  assert.match(html, /<script src="theme\.js"><\/script>\s*<link rel="stylesheet" href="app\.css">/);
  assert.match(html, /<fieldset id="themeMode"[\s\S]*value="light"[\s\S]*value="system"[\s\S]*value="dark"/);
  assert.match(themeScript, /prefers-color-scheme: dark/);
  assert.match(themeScript, /localStorage\.umiroTheme/);
  assert.match(css, /:root\s*\{[\s\S]*color-scheme: light/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[\s\S]*color-scheme: dark/);
  assert.match(script, /path: 'model', type: 'model'/);
  assert.match(script, /input\.type = 'radio'/);
  assert.match(script, /path: 'embedding\.baseUrl', type: 'secret'/);
  assert.match(script, /path: 'embedding\.baseUrl', type: 'secret', inputType: 'url'/);
  assert.match(script, /title: '模型與 Context'[\s\S]*?secretName: 'LLM_BASE_URL'[\s\S]*?secretName: 'LLM_API_KEY'/);
  assert.match(script, /connectModels: true/);
  assert.match(script, /api\('\/api\/models\/discover', \{ method: 'POST'/);
  assert.match(script, /showToast\('連接成功，共取得 '/);
  assert.match(css, /\.provider-connect/);
  assert.match(script, /classList\.add\('config-checkbox-label'\)/);
  assert.match(script, /subgroup\.className = 'config-subgroup config-wide'/);
  assert.match(css, /\.config-checkbox-label \{[^}]*inline-flex/);
  assert.match(css, /\.config-subgroup \{[^}]*border-left:/);
  assert.match(css, /\.config-subgroup\[hidden\] \{ display: none; \}/);
  assert.match(script, /title: 'Discord'[\s\S]*?secretName: 'DISCORD_TOKEN'[\s\S]*?secretName: 'UMIRO_OWNER_DISCORD_ID'/);
  assert.match(script, /path: 'conversation\.autoArchive\.enabled', type: 'checkbox'/);
  assert.match(script, /path: 'conversation\.autoArchive\.time', type: 'time'/);
  assert.match(script, /path: 'conversation\.autoArchive\.timezone', type: 'text'/);
  assert.match(script, /subgroup: 'conversation-auto-archive'/);
  assert.match(html, /id="userSchedules"/);
  assert.match(html, /id="pluginSchedules"/);
  assert.match(html, /id="systemSchedules"/);
  assert.match(html, /我的排程/);
  assert.match(html, /外掛排程/);
  assert.match(html, /系統排程/);
  assert.match(script, /owner\?\.kind === 'user'/);
  assert.match(script, /function renderManagedSchedule/);
  assert.match(script, /外掛設定/);
  assert.match(script, /openConversationAutoArchiveSettings/);
  assert.doesNotMatch(script.slice(script.indexOf('function renderManagedSchedule'), script.indexOf('function renderManagedSchedule') + 2500), /method: 'PATCH'|method: 'DELETE'/);
  assert.match(script, /preserveWhenHidden: true/);
  assert.match(script, /每天指定時間後會封存各 Discord 頻道/);
  assert.match(script, /停止追蹤/);
  assert.match(script, /stopPropagation\(\)/);
  assert.match(script, /method: 'DELETE'/);
  assert.match(script, /\/api\/channels\/.*tracking/);
  assert.match(script, /aria-label/);
  assert.match(css, /channel-select/);
  assert.match(css, /channel-untrack/);
  assert.match(css, /--sidebar:\s*#363c4c/);
  assert.match(css, /--accent:\s*#6c98e1/);
  assert.match(css, /--warning:\s*#faa731/);
  assert.match(css, /--success:\s*#3b9b61/);
  assert.match(css, /--danger:\s*#d86e74/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:root\[data-theme="dark"\] \{[\s\S]*--bg: #222326/);
  assert.match(css, /--danger-accent:\s*#fb9091/);
  assert.match(css, /\.schedule-actions #createSchedule \{[^}]*min-height: 42px/);
  assert.match(css, /\.workspace-empty-state/);
  assert.match(html, /<img class="brand-mark" src="favicon\.png"/);
  assert.match(html, /<details class="connection-panel">[\s\S]*id="token"[\s\S]*id="connect"/);
  assert.match(html, /id="currentPageTitle"/);
  assert.match(html, /data-page="channels">Discord 頻道/);
  assert.match(html, /data-page="schedules">排程與提醒/);
  assert.match(html, /data-page="plugins">外掛管理/);
  assert.match(html, /data-page="workspace">工作區/);
  assert.match(html, /data-page="runs">執行紀錄/);
  assert.match(html, /data-page="usage">用量與日誌/);
  assert.match(html, /id="page-config" class="page" data-title="設定"/);
  assert.match(html, /<label class="form-field">名稱<input id="scheduleName"/);
  assert.match(html, /<label class="form-field">時區<input id="scheduleTimezone"/);
  assert.match(html, /id="workspaceEmptyState"/);
  assert.match(html, /id="document"[^>]*disabled hidden/);
  assert.match(html, /id="saveDocument" disabled/);
  assert.match(script, /\$\('currentPageTitle'\)\.textContent = title/);
  assert.match(script, /classList\.add\('connected'\)/);
  assert.match(script, /\$\('scheduleWhenLabel'\)\.textContent = once \? '提醒時間' : 'Cron 表達式'/);
  assert.match(script, /\$\('workspaceEmptyState'\)\.hidden = true/);
  assert.match(script, /\$\('saveDocument'\)\.disabled = false/);
  assert.match(script, /function scheduleSummary\(x, owner\)/);
  assert.match(script, /const stateLabel = \{ succeeded: '完成', failed: '失敗'/);
  assert.match(html, /class="conversation-browser(?: current-conversation-browser)?"[\s\S]*id="channelConversation"[\s\S]*id="archivedList"[\s\S]*id="archivedConversation"/);
  assert.match(html, /class="conversation-browser current-conversation-browser"[\s\S]*id="channelConversation"/);
  assert.match(css, /#page-channels \.conversation-browser\s*\{[^}]*grid-template-columns/);
  assert.match(css, /#page-channels \.current-conversation-browser\s*\{[^}]*height: clamp\(/);
  assert.match(css, /current-conversation-browser #channelConversation \.chat[^}]*flex: 1 1 auto[^}]*min-height: 0/);
  assert.match(css, /\.page\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /#page-channels \.conversation-tree summary::before/);
  assert.match(css, /#page-channels \.archive-tree summary::before/);
  assert.match(css, /#page-channels \.channel-select:focus-visible/);
  assert.doesNotMatch(html, /名稱直接向 Discord 取得|ID 僅作為穩定識別/);
  const channelRow = script.slice(script.indexOf('const channelRow ='), script.indexOf('for (const guild of guilds.values())'));
  assert.match(channelRow, /className = 'channel-select'/);
  assert.match(channelRow, /select\.onclick =/);
  assert.match(channelRow, /title = '停止追蹤 '/);
  assert.doesNotMatch(channelRow, /未知模型|reasoningEffort|textContent = ' — '/);
  assert.match(script, /tree\.className = 'conversation-tree'/);
  assert.match(script, /const isThread = item\.kind === 'thread'/);
  assert.match(script, /const channelId = isThread \? \(item\.parentId/);
  assert.match(script, /channelRow\(channel\.item, '目前對話'\)/);
  assert.match(script, /children\.push\(channelRow\(thread, thread\.name \|\| thread\.id\)\)/);
  assert.match(script, /if \(el\) await showChannelConversation\(selectedChannelId, el\)/);
  assert.match(script, /async function showChannelConversation\(channelId, element\)/);
  assert.match(script, /\/api\/conversations\?state=archived&limit=200/);
  assert.match(script, /const isThread = scope\.kind === 'thread'/);
  assert.match(script, /const channelId = isThread \? \(scope\.parentId/);
  assert.match(script, /function archiveTimestamp\(item\)[\s\S]*item\.archivedAt \|\| item\.lastActivityAt \|\| item\.createdAt/);
  assert.match(script, /className = 'archive-tree'/);
  assert.doesNotMatch(css, /\.archived-item|\.archived-group/);
  assert.match(main, /archivedAt: summary\.conversation\.state === "archived" \? summary\.conversation\.updatedAt : null/);
  assert.doesNotMatch(script, /UMIRO_WEB_UI_TOKEN/);
  const editableSecrets = main.slice(main.indexOf("const editableSecretNames"), main.indexOf("const persistSecrets"));
  assert.match(editableSecrets, /editableSecretNames\.delete\("UMIRO_WEB_UI_TOKEN"\)/);
  assert.doesNotMatch(script, /\$\('config-embedding-baseUrl'\)\.value = ''/);
  assert.match(script, /const secretFields = configFields\(\)\.filter\(field => field\.type === 'secret'\)/);
  assert.match(script, /if \(!field\.publicValue\) control\.value = ''/);
  assert.match(script, /field\.type === 'model' && models\.length === 0/);
  assert.match(script, /document\.createElement\('select'\)/);
  assert.match(script, /className = 'config-tooltip'/);
  assert.match(script, /config-restart-required/);
  assert.doesNotMatch(script, /儲存後需重啟|儲存後即時生效/);
  assert.match(html, /class="config-restart-legend">此顏色的欄位名稱需重啟/);
  assert.match(css, /--restart-required:/);
  assert.match(html, /id="toastRegion"/);
  assert.match(html, /id="modalBackdrop"/);
  assert.match(html, /id="configSearch"/);
  assert.match(html, /id="runtimeCards"/);
  assert.match(html, /id="documentPreview"/);
  assert.match(html, /id="scheduleTime" type="time"/);
  assert.doesNotMatch(html, /id="scheduleHour"|id="scheduleMinute"/);
  assert.match(script, /Number\(minute\) \+ ' ' \+ Number\(hour\)/);
  assert.match(script, /if \(button\.textContent === busyText\) button\.textContent = original/);
  const scheduleReset = script.slice(script.indexOf("function resetScheduleForm"), script.indexOf("let previewTimer"));
  for (const id of ["scheduleName", "scheduleWhen", "schedulePrompt", "scheduleChannel", "scheduleChannelId"]) assert.match(scheduleReset, new RegExp(`\\$\\('${id}'\\)\\.value = ''`));
  assert.match(scheduleReset, /editingSchedule = undefined/);
  assert.match(scheduleReset, /\$\('scheduleKind'\)\.value = 'cron'/);
  assert.match(scheduleReset, /\$\('scheduleFrequency'\)\.value = 'daily'/);
  assert.match(scheduleReset, /\$\('scheduleTime'\)\.value = '09:00'/);
  assert.match(scheduleReset, /updateScheduleControls\(\)/);
  assert.match(script, /resetScheduleForm\(\);\s*await schedules\(\)/);
  assert.match(script, /await pluginAction\('install',[\s\S]*?\$\('pluginSource'\)\.value = ''; \$\('pluginWorkspace'\)\.value = '';/);
  assert.match(script, /configSchema/);
  assert.match(script, /requiredSecrets/);
  assert.match(script, /optionalSecrets/);
  assert.match(script, /data-plugin-secret-key/);
  assert.match(script, /只會儲存在 secrets\.env，不會回顯/);
  const pluginUi = script.slice(script.indexOf("async function pluginAction"), script.indexOf("function sourceBaseName"));
  assert.match(pluginUi, /const payload = \{ action, source, workspace, config \};/);
  assert.match(pluginUi, /if \(action === 'remove' && removeSecrets === true\) payload\.removeSecrets = true;/);
  assert.match(pluginUi, /JSON\.stringify\(payload\)/);
  assert.doesNotMatch(pluginUi, /JSON\.parse\(basePayload\)/);
  assert.match(pluginUi, /await api\('\/api\/secrets', \{ method: 'PUT', body: JSON\.stringify\(secrets\) \}\)/);
  assert.match(pluginUi, /const secrets = Object\.fromEntries\(\[\.\.\.body\.querySelectorAll\('\[data-plugin-secret-key\]'\)[\s\S]*?filter\(\(\[, value\]\) => value\)\)/);
  assert.match(pluginUi, /filter\(\(\[name\]\) => !secretNames\.has\(name\)\)/);
  assert.match(pluginUi, /markPluginSecretsConfigured\(body, new Set\(Object\.keys\(secrets\)\)\)/);
  assert.match(pluginUi, /control\.value = '';[\s\S]*control\.placeholder = '已設定；留空不變'/);
  assert.match(pluginUi, /await api\('\/api\/plugins\/action'[\s\S]*await plugins\(\)/);
  const removeModal = script.slice(script.indexOf("async function confirmPluginRemoval"), script.indexOf("function renderPluginRow"));
  assert.match(removeModal, /dataset\.removePluginSecrets/);
  assert.match(removeModal, /control\.checked = false/);
  assert.match(removeModal, /\.filter\(name => typeof name === 'string' && secretStatus\[name\]\)/);
  assert.match(removeModal, /停用不會刪除 Secret；其他外掛共用或 ümiro 核心 Secret 會保留/);
  assert.doesNotMatch(pluginUi, /required\s*=\s*true/);
  assert.match(script, /\/api\/schedules\/preview/);
  assert.match(script, /\/api\/runtime\/restart/);
  assert.match(html, /id="pluginRestartNotice"[^>]*hidden/);
  assert.match(html, /id="restartPlugins"[^>]*>立即重啟<\/button>/);
  assert.match(script, /function markPluginRestartRequired[\s\S]*?pluginRestartNotice[\s\S]*?hidden = false/);
  assert.match(script, /restartPlugins'\)\.onclick = restartGateway/);
  assert.match(script, /pluginRestartNotice'\)\.hidden = true/);
  assert.doesNotMatch(script, /\balert\(|\bprompt\(/);
  assert.match(script, /api\('\/api\/secrets', \{ method: 'PUT'/);
  assert.match(script, /await r\.text\(\)/);
  assert.match(script, /無法連線到 ümiro Gateway/);
  assert.match(html, /id="pluginNavSection"[^>]*hidden/);
  assert.match(html, /id="pluginNavLinks"/);
  const pluginViews = script.slice(script.indexOf("function renderMarkdown(target, content)"), script.indexOf("$('connect').onclick"));
  assert.match(pluginViews, /api\('\/api\/plugin-views/);
  assert.match(pluginViews, /markdown-collection/);
  assert.match(pluginViews, /page\.dataset\.title = metadata\.title\.trim\(\)/);
  assert.match(pluginViews, /renderMarkdown\(entry\.page\.querySelector/);
  assert.doesNotMatch(pluginViews, /innerHTML|contenteditable/);
  assert.match(script, /\$\('state'\)\.textContent = '已連線';\s*\$\('state'\)\.classList\.add\('connected'\);\s*showPage\(\);/);
  assert.match(css, /\.plugin-view-layout \{[^}]*grid-template-columns:/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.plugin-view-layout \{ grid-template-columns: 1fr; \}/);
});

test("settings save only reads edited config fields and secrets", async () => {
  const script = await readFile(scriptUrl, "utf8");
  const tracking = script.slice(script.indexOf("function trackEditedConfigField("), script.indexOf("function markWorkspaceDirty("));
  const pathHelpers = script.slice(script.indexOf("function getPath("), script.indexOf("function option("));
  const readers = script.slice(script.indexOf("function readConfigForm("), script.indexOf("const headers ="));
  const loadedConfig = { model: "old-model", embedding: { provider: "openai-compatible", model: "embed-model" } };
  const fields = [
    { path: "model", type: "model" },
    { path: "protocol", type: "select" },
    { path: "profiles", type: "json" },
    { path: "embedding.baseUrl", type: "secret", secretName: "UMIRO_EMBEDDING_BASE_URL" },
  ];
  const controls: Record<string, { value: string; checkValidity: () => boolean }> = {
    "config-model": { value: "new-model", checkValidity: () => true },
    "config-protocol": { value: "openai_responses", checkValidity: () => true },
    "config-profiles": { value: "", checkValidity: () => true },
    "config-embedding-baseUrl": { value: "https://embed.example/v1", checkValidity: () => true },
  };
  const editedConfigPaths = new Set(["model"]);
  const result = runInNewContext(`${pathHelpers}\n${readers}\n({ config: readConfigForm(), secrets: readEditedSecretValues() })`, {
    loadedConfig, editedConfigPaths, configFields: () => fields,
    fieldId: (path: string) => "config-" + path.replace(/[^A-Za-z0-9_-]/g, "-"),
    $: (id: string) => controls[id], structuredClone,
  }) as { config: unknown; secrets: unknown };
  assert.deepEqual(JSON.parse(JSON.stringify(result.config)), { ...loadedConfig, model: "new-model" });
  assert.deepEqual(JSON.parse(JSON.stringify(result.secrets)), {});
  assert.match(script, /wrapper\.dataset\.configPath = field\.secretName \|\| field\.path/);
  assert.match(script, /function renderConfigForm\(schema, config, models\) \{\s*loadedConfig = structuredClone\(config\);\s*editedConfigPaths\.clear\(\)/);
  assert.match(script, /loadedConfig = next; editedConfigPaths\.clear\(\); markConfigSaved\(\)/);
  runInNewContext(`${tracking}\ntrackEditedConfigField(target)`, {
    editedConfigPaths,
    target: { closest: () => ({ dataset: { configPath: "UMIRO_EMBEDDING_BASE_URL" } }) },
  });
  const secret = runInNewContext(`${readers}\nreadEditedSecretValues()`, {
    editedConfigPaths, configFields: () => fields,
    fieldId: (path: string) => "config-" + path.replace(/[^A-Za-z0-9_-]/g, "-"),
    $: (id: string) => controls[id],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(secret)), { UMIRO_EMBEDDING_BASE_URL: "https://embed.example/v1" });
  const main = await readFile(mainUrl, "utf8");
  assert.match(main, /if \(changed\(defaultModelProfile\.model, nextModels\.defaultProfile\.model\)\) applied\.push\("model"\)/);
});

test("user schedule rows render with a summary and actions", async () => {
  const script = await readFile(scriptUrl, "utf8");
  const source = script.slice(script.indexOf("function scheduleSummary(x, owner)"), script.indexOf("function renderManagedSchedule(x, plugin)"));
  const createElement = () => {
    const children: unknown[] = [];
    return { children, append: (...nodes: unknown[]) => children.push(...nodes), setAttribute: () => undefined };
  };
  const row = runInNewContext(`${source}\nrenderUserSchedule(input)`, {
    document: { createElement },
    scheduleLabel: () => "每天 09:00",
    input: { id: "schedule-1", name: "晨間提醒", enabled: true },
  }) as { children: unknown[] };
  assert.equal(row.children.length, 4);
});
