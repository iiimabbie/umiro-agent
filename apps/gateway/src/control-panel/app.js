const $ = id => document.getElementById(id);
let file;
let editingSchedule;
let channelCatalog = new Map();
let pluginCatalog = new Map();
let channelRefreshTimer;
let selectedChannelId;
let loadedConfig;
let configSchema;
let configDirty = false;
let workspaceDirty = false;
let workspaceSavedAt;
let modalResolve;

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  $('toastRegion').append(toast);
  window.setTimeout(() => toast.remove(), type === 'error' ? 7000 : 4000);
}

function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function reportError(error) { showToast(errorMessage(error), 'error'); }
async function withBusy(button, work, busyText = '處理中…') {
  if (!button || button.disabled) return;
  const original = button.textContent;
  button.disabled = true; button.textContent = busyText;
  try { return await work(); } finally { button.disabled = false; if (button.textContent === busyText) button.textContent = original; }
}

function confirmAction(title, message, confirmText = '確認') {
  $('modalTitle').textContent = title;
  const body = $('modalBody'); body.replaceChildren();
  const text = document.createElement('p'); text.textContent = message; body.append(text);
  $('modalConfirm').textContent = confirmText;
  $('modalBackdrop').hidden = false;
  return new Promise(resolve => { modalResolve = resolve; });
}

function closeModal(value) {
  $('modalBackdrop').hidden = true;
  const resolve = modalResolve; modalResolve = undefined;
  resolve?.(value);
}

function markConfigDirty() {
  configDirty = true;
  $('configSaveState').textContent = '有未儲存變更';
  $('configSaveState').className = 'save-state dirty';
}

function markConfigSaved(message = '設定已儲存') {
  configDirty = false;
  $('configSaveState').textContent = message;
  $('configSaveState').className = 'save-state saved';
}

function markWorkspaceDirty() {
  workspaceDirty = true;
  $('workspaceSaveState').textContent = '有未儲存變更';
  $('workspaceSaveState').className = 'save-state dirty';
}

const CONFIG_GROUPS = [
  { title: '模型與 Context', fields: [
    { path: 'LLM_BASE_URL', type: 'secret', secretName: 'LLM_BASE_URL', inputType: 'url', publicValue: true, wide: true, label: 'LLM Base URL', description: 'OpenAI-compatible API 的端點，例如 https://api.openai.com/v1。', defaultValue: null, risk: '模型請求會傳送到此 endpoint；只能使用信任的服務。', restartRequired: false },
    { path: 'LLM_API_KEY', type: 'secret', secretName: 'LLM_API_KEY', wide: true, connectModels: true, label: 'LLM API Key', description: '主要模型 provider 的密鑰；只寫入 secrets.env，不會回傳已設定值。填好 URL 與 Key 後可按「連接」取得模型清單。', defaultValue: null, risk: '這是 provider 憑證，只應填入信任的服務。', restartRequired: false },
    { path: 'protocol', type: 'select', options: [['openai_responses', 'OpenAI Responses'], ['openai_chat_completions', 'Chat Completions']] },
    { path: 'model', type: 'model', required: true },
    { path: 'modelCapabilities', type: 'checks', wide: true, options: [['vision', '圖片理解'], ['function_tools', '工具呼叫'], ['hosted_web_search', 'Hosted Web Search'], ['hosted_image_generation', 'Hosted Image Generation'], ['hosted_code_execution', 'Hosted Code Execution']] },
    { path: 'contextMaxTokens', type: 'number', min: 256, max: 1000000, step: 1 },
    { path: 'profiles', type: 'json', wide: true },
    { path: 'pricing', type: 'json', wide: true },
    { path: 'skills', type: 'list', wide: true, placeholder: '每行一個 workspace skill 名稱' },
  ] },
  { title: 'Embedding 與跨對話記憶', fields: [
    { path: 'embedding.provider', type: 'select', options: [['disabled', '停用（只使用 FTS）'], ['gemini', 'Gemini'], ['openai-compatible', 'OpenAI-compatible']] },
    { path: 'embedding.model', type: 'text', placeholder: '例如 voyage-3.5-lite' },
    { path: 'embedding.separateQueryModel', type: 'checkbox', label: '分離 Query 向量模型', dependsOn: { path: 'embedding.provider', not: 'disabled' }, wide: true },
    { path: 'embedding.separationWarning', type: 'warning', dependsOn: { path: 'embedding.separateQueryModel', value: true }, subgroup: 'embedding-query', wide: true },
    { path: 'embedding.queryModel', type: 'text', placeholder: '例如 voyage-4-lite', required: true, dependsOn: { path: 'embedding.separateQueryModel', value: true }, subgroup: 'embedding-query' },
    { path: 'embedding.dimensions', type: 'number', min: 1, max: 65536, step: 1, required: true, dependsOn: { path: 'embedding.separateQueryModel', value: true }, subgroup: 'embedding-query' },
    { path: 'embedding.baseUrl', type: 'secret', inputType: 'url', secretName: 'UMIRO_EMBEDDING_BASE_URL', publicValue: true, wide: true, placeholder: 'https://api.example.com/v1' },
    { path: 'embedding.apiKey', type: 'secret', secretName: 'UMIRO_EMBEDDING_API_KEY', wide: true },
    { path: 'embedding.requestsPerMinute', type: 'number', min: 1, max: 600, step: 1 },
    { path: 'embedding.recallLimit', type: 'number', min: 1, max: 20, step: 1 },
    { path: 'embedding.minSimilarity', type: 'number', min: 0, max: 1, step: 0.01 },
  ] },
  { title: 'Discord', fields: [
    { path: 'DISCORD_TOKEN', type: 'secret', secretName: 'DISCORD_TOKEN', wide: true, label: 'Discord Bot Token', description: 'Discord bot 的登入憑證；只寫入 secrets.env，不會回傳已設定值。', defaultValue: null, risk: '任何取得此 token 的人都可能控制 bot，請勿分享。', restartRequired: true },
    { path: 'UMIRO_OWNER_DISCORD_ID', type: 'secret', secretName: 'UMIRO_OWNER_DISCORD_ID', inputType: 'text', wide: true, label: 'Owner Discord ID', description: '唯一具有 Owner 身分的 Discord 使用者 ID。', defaultValue: null, risk: '填錯會把最高權限指派給錯誤帳號，或讓真正 Owner 失去權限。', restartRequired: false },
    { path: 'discord.allowedGuilds', type: 'list', placeholder: '每行一個 guild ID' },
    { path: 'discord.allowedChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.ignoredChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.ambientChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.queueMode', type: 'select', options: [['queue', 'Queue：等目前工作完成'], ['steer', 'Steer：併入目前工作']] },
    { path: 'discord.respondToBots', type: 'boolean' },
    { path: 'discord.presence.status', type: 'select', options: [['online', 'Online'], ['idle', 'Idle'], ['dnd', 'Do Not Disturb'], ['invisible', 'Invisible']] },
    { path: 'discord.presence.activity', type: 'text', placeholder: 'Bot 名稱下方顯示的文字' },
  ] },
  { title: '對話', fields: [
    { path: 'conversation.autoArchive.enabled', type: 'checkbox', label: '對話自動封存', wide: true },
    { path: 'conversation.autoArchive.explanation', type: 'warning', dependsOn: { path: 'conversation.autoArchive.enabled', value: true }, subgroup: 'conversation-auto-archive', wide: true, label: '對話自動封存說明' },
    { path: 'conversation.autoArchive.time', type: 'time', required: true, preserveWhenHidden: true, dependsOn: { path: 'conversation.autoArchive.enabled', value: true }, subgroup: 'conversation-auto-archive' },
    { path: 'conversation.autoArchive.timezone', type: 'text', required: true, preserveWhenHidden: true, placeholder: '例如 Asia/Taipei', dependsOn: { path: 'conversation.autoArchive.enabled', value: true }, subgroup: 'conversation-auto-archive' },
  ] },
  { title: '權限與 Subagent', fields: [
    { path: 'authority.owner', type: 'json', wide: true },
    { path: 'authority.member', type: 'json', wide: true },
    { path: 'subagent.maxConcurrentChildren', type: 'select', optional: true, options: [['', '使用預設值'], ['1', '1'], ['2', '2']] },
    { path: 'subagent.maxParallelTools', type: 'select', optional: true, options: [['', '使用預設值'], ['1', '1'], ['2', '2']] },
  ] },
  { title: '外掛與 Web UI', fields: [
    { path: 'plugins', type: 'json', wide: true },
    { path: 'webUi.enabled', type: 'boolean' },
    { path: 'webUi.host', type: 'select', options: [['127.0.0.1', '127.0.0.1（IPv4 localhost）'], ['::1', '::1（IPv6 localhost）']] },
    { path: 'webUi.port', type: 'number', min: 1, max: 65535, step: 1 },
  ] },
];

const configFields = () => CONFIG_GROUPS.flatMap(group => group.fields);
const fieldId = path => 'config-' + path.replace(/[^A-Za-z0-9_-]/g, '-');
let secretStatus = {};

function jumpToConfig(section) {
  const heading = section?.querySelector('h3');
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  const appHeaderHeight = document.querySelector('.app-header')?.getBoundingClientRect().height ?? 0;
  const toolbarHeight = document.querySelector('.config-toolbar')?.getBoundingClientRect().height ?? 0;
  const offset = appHeaderHeight + toolbarHeight + 12;
  window.scrollTo({ top: window.scrollY + heading.getBoundingClientRect().top - offset, behavior: 'smooth' });
}

function getPath(value, path) {
  return path.split('.').reduce((current, key) => current && typeof current === 'object' ? current[key] : undefined, value);
}

function setPath(value, path, next) {
  const keys = path.split('.');
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  current[keys.at(-1)] = next;
}

function deletePath(value, path) {
  const keys = path.split('.');
  const parents = [];
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return;
    parents.push([current, key]);
    current = current[key];
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return;
  delete current[keys.at(-1)];
  for (const [parent, key] of parents.reverse()) {
    if (parent[key] && typeof parent[key] === 'object' && !Array.isArray(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
    else break;
  }
}

function option(value, label) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  return item;
}

function configControl(field, value, models) {
  const id = fieldId(field.path);
  if (field.type === 'model' && models.length === 0) {
    const input = document.createElement('input');
    input.id = id;
    input.type = 'text';
    input.placeholder = '輸入 API 提供的模型 ID';
    input.value = value === 'not-configured' ? '' : String(value ?? '');
    input.required = true;
    return input;
  }
  if (field.type === 'warning') {
    const warning = document.createElement('div'); warning.className = 'config-warning'; warning.textContent = field.path === 'conversation.autoArchive.explanation'
      ? '每天指定時間後會封存各 Discord 頻道、Thread／Forum post 與私訊目前的 conversation。下一則訊息會開始新的 conversation；封存不會刪除歷史，model、reasoning、queue 等偏好也會保留。執行中的 Run 會在完成後補封存；關閉只停止未來排程，/new 仍可手動提早封存。'
      : '只有 provider 官方保證文件與 Query 模型共享向量空間時才能分離；相同維度不等於向量相容。Voyage 4 與 voyage-4-lite 可作為例子，但請以你選用 provider 的官方保證為準。'; return warning;
  }
  if (field.type === 'checkbox') {
    const input = document.createElement('input'); input.type = 'checkbox'; input.id = id; input.checked = value === true; return input;
  }
  if (field.type === 'boolean') {
    const box = document.createElement('div');
    box.className = 'radio-group';
    for (const [raw, label] of [['true', '是'], ['false', '否']]) {
      const wrapper = document.createElement('label');
      wrapper.className = 'radio-option';
      const input = document.createElement('input');
      input.type = 'radio'; input.name = id; input.value = raw; input.checked = value === (raw === 'true');
      wrapper.append(input, label);
      box.append(wrapper);
    }
    return box;
  }
  if (field.type === 'checks') {
    const box = document.createElement('div');
    box.className = 'checkbox-group';
    const selected = new Set(Array.isArray(value) ? value : []);
    for (const [raw, label] of field.options) {
      const wrapper = document.createElement('label');
      wrapper.className = 'checkbox-option';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.value = raw; input.checked = selected.has(raw);
      wrapper.append(input, label);
      box.append(wrapper);
    }
    return box;
  }
  if (field.type === 'select' || field.type === 'model') {
    const select = document.createElement('select');
    select.id = id;
    let options = field.type === 'model' ? models.map(model => [model, model]) : field.options;
    const selectedValue = field.type === 'model' && value === 'not-configured' ? undefined : value;
    if (selectedValue !== undefined && selectedValue !== null && !options.some(([raw]) => String(raw) === String(selectedValue))) options = [[String(selectedValue), String(selectedValue) + '（目前設定）'], ...options];
    select.replaceChildren(...options.map(([raw, label]) => option(raw, label)));
    select.value = selectedValue === undefined || selectedValue === null ? String(options[0]?.[0] ?? '') : String(selectedValue);
    if (field.required) select.required = true;
    return select;
  }
  if (field.type === 'json' || field.type === 'list') {
    const textarea = document.createElement('textarea');
    textarea.id = id;
    textarea.className = field.type === 'json' ? 'config-json' : '';
    textarea.placeholder = field.placeholder || (field.type === 'json' ? 'JSON；留空表示使用預設值' : '每行一項');
    textarea.value = field.type === 'json' ? (value === undefined ? '' : JSON.stringify(value, null, 2)) : (Array.isArray(value) ? value.join('\n') : '');
    return textarea;
  }
  if (field.type === 'secret') {
    const input = document.createElement('input');
    input.id = id;
    input.type = field.inputType || 'password';
    input.autocomplete = 'new-password';
    if (typeof secretStatus[field.secretName] === 'string') input.value = secretStatus[field.secretName];
    input.placeholder = field.placeholder || (secretStatus[field.secretName] ? '已設定；留空不變' : '尚未設定');
    return input;
  }
  const input = document.createElement('input');
  input.id = id;
  input.type = field.type;
  input.placeholder = field.placeholder || '';
  if (value !== undefined && value !== null) input.value = String(value);
  if (field.required) input.required = true;
  if (field.min !== undefined) input.min = String(field.min);
  if (field.max !== undefined) input.max = String(field.max);
  if (field.step !== undefined) input.step = String(field.step);
  return input;
}

function renderConfigForm(schema, config, models) {
  loadedConfig = structuredClone(config);
  configSchema = schema;
  const nav = $('configNav');
  nav.replaceChildren(...CONFIG_GROUPS.map((group, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = group.title;
    button.onclick = () => jumpToConfig($('config-group-' + index));
    return button;
  }));
  const groups = CONFIG_GROUPS.map((group, groupIndex) => {
    const section = document.createElement('section');
    section.className = 'config-group'; section.id = 'config-group-' + groupIndex; section.dataset.configGroup = group.title;
    const title = document.createElement('h3');
    title.textContent = group.title;
    const grid = document.createElement('div');
    grid.className = 'config-grid';
    const subgroups = new Map();
    for (const field of group.fields) {
      const explanation = field.type === 'secret' && field.label ? field : schema[field.path];
      if (!explanation) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'config-field' + (field.wide ? ' config-wide' : '');
      if (field.dependsOn) { wrapper.dataset.dependsOn = field.dependsOn.path; wrapper.dataset.dependsValue = field.dependsOn.value === undefined ? `not:${field.dependsOn.not}` : String(field.dependsOn.value); }
      wrapper.dataset.configPath = field.secretName || field.path; wrapper.dataset.configLabel = explanation.label;
      const label = document.createElement('label');
      label.className = 'config-label' + (explanation.restartRequired ? ' config-restart-required' : '');
      label.tabIndex = 0;
      const labelText = document.createElement('span');
      labelText.textContent = explanation.label;
      const tooltip = document.createElement('span');
      tooltip.className = 'config-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = explanation.description + '\n\n預設：' + JSON.stringify(explanation.defaultValue) + '\n\n風險：' + explanation.risk;
      label.append(labelText, tooltip);
      const path = document.createElement('div');
      path.className = 'config-path';
      path.textContent = field.secretName || field.path;
      const value = getPath(config, field.path);
      const controlValue = value === undefined && field.type !== 'json' ? explanation.defaultValue : value;
      const control = configControl(field, controlValue, models);
      if (field.type === 'checkbox') {
        label.classList.add('config-checkbox-label');
        label.htmlFor = control.id;
        label.replaceChildren(control, labelText, tooltip);
        wrapper.append(label);
      } else if (field.type === 'warning') {
        wrapper.append(control);
      } else if (field.connectModels) {
        const row = document.createElement('div'); row.className = 'provider-connect';
        const button = document.createElement('button'); button.id = 'connectModels'; button.type = 'button'; button.textContent = '連接';
        button.onclick = () => withBusy(button, discoverModels, '連接中…').catch(reportError);
        row.append(control, button); wrapper.append(label, path, row);
      } else wrapper.append(label, path, control);
      if (field.subgroup) {
        let subgroup = subgroups.get(field.subgroup);
        if (!subgroup) {
          subgroup = document.createElement('div');
          subgroup.className = 'config-subgroup config-wide';
          subgroup.dataset.conditionalGroup = field.subgroup;
          subgroups.set(field.subgroup, subgroup);
          grid.append(subgroup);
        }
        subgroup.append(wrapper);
      } else grid.append(wrapper);
    }
    section.append(title, grid);
    return section;
  });
  $('configForm').replaceChildren(...groups);
  markConfigSaved('設定已載入');
  const updateConditionalFields = () => {
    for (const field of configFields()) {
      if (!field.dependsOn) continue;
      const dependency = $(fieldId(field.dependsOn.path));
      const actual = dependency?.type === 'checkbox' ? dependency.checked : dependency?.value;
      const visible = field.dependsOn.value === undefined ? actual !== field.dependsOn.not : actual === field.dependsOn.value;
      const wrapper = document.querySelector(`[data-config-path="${field.path}"]`);
      if (wrapper) { wrapper.hidden = !visible; for (const control of wrapper.querySelectorAll('input,select,textarea')) control.disabled = !visible; }
    }
    for (const subgroup of document.querySelectorAll('[data-conditional-group]')) subgroup.hidden = ![...subgroup.children].some(child => !child.hidden);
  };
  $('configForm').oninput = () => { updateConditionalFields(); markConfigDirty(); };
  $('configForm').onchange = () => { updateConditionalFields(); markConfigDirty(); };
  updateConditionalFields();
}

async function discoverModels() {
  const baseUrl = $('config-LLM_BASE_URL');
  const apiKey = $('config-LLM_API_KEY');
  if (!baseUrl?.value.trim() || !baseUrl.checkValidity()) { baseUrl?.reportValidity(); throw new Error('請先填入有效的 LLM Base URL'); }
  const current = $('config-model')?.value;
  const payload = { baseUrl: baseUrl.value.trim(), ...(apiKey?.value.trim() ? { apiKey: apiKey.value.trim() } : {}) };
  const models = (await api('/api/models/discover', { method: 'POST', body: JSON.stringify(payload) })).filter(model => typeof model === 'string');
  if (!models.length) throw new Error('模型端點沒有回傳可用模型');
  const field = configFields().find(candidate => candidate.path === 'model');
  const wrapper = document.querySelector('[data-config-path="model"]');
  const previous = wrapper?.querySelector('#config-model');
  if (!field || !wrapper || !previous) throw new Error('找不到主要模型欄位');
  const next = configControl(field, current, models);
  previous.replaceWith(next);
  if (next.value !== current) markConfigDirty();
  showToast('連接成功，共取得 ' + models.length + ' 個模型', 'success');
}

function filterConfigFields() {
  const query = $('configSearch').value.trim().toLocaleLowerCase();
  for (const field of document.querySelectorAll('.config-field')) {
    const haystack = (field.dataset.configPath + ' ' + field.dataset.configLabel).toLocaleLowerCase();
    field.classList.toggle('config-hidden', Boolean(query) && !haystack.includes(query));
  }
}

function readConfigForm() {
  const next = structuredClone(loadedConfig);
  if ($('config-embedding-provider')?.value === 'disabled') {
    deletePath(next, 'embedding.separateQueryModel');
    deletePath(next, 'embedding.queryModel');
    deletePath(next, 'embedding.dimensions');
  }
  for (const field of configFields()) {
    if (field.type === 'secret') continue;
    if (field.type === 'warning') continue;
    if (field.dependsOn) {
      const dependency = $(fieldId(field.dependsOn.path));
      const actual = dependency?.type === 'checkbox' ? dependency.checked : dependency?.value;
      const visible = field.dependsOn.value === undefined ? actual !== field.dependsOn.not : actual === field.dependsOn.value;
      if (!visible) { if (!field.preserveWhenHidden) deletePath(next, field.path); continue; }
    }
    if (field.type === 'checkbox') {
      const control = $(fieldId(field.path));
      setPath(next, field.path, Boolean(control?.checked));
      continue;
    }
    const id = fieldId(field.path);
    if (field.type === 'boolean') {
      const checked = document.querySelector('input[name="' + id + '"]:checked');
      if (!checked) throw new Error(field.path + ' 請選擇是或否');
      setPath(next, field.path, checked.value === 'true');
      continue;
    }
    if (field.type === 'checks') {
      setPath(next, field.path, [...document.querySelectorAll('#configForm input[type="checkbox"]')].filter(input => input.closest('.config-field')?.querySelector('.config-path')?.textContent === field.path && input.checked).map(input => input.value));
      continue;
    }
    const control = $(id);
    if (!control) continue;
    if (!control.checkValidity()) { control.reportValidity(); throw new Error(field.path + ' 的值無效'); }
    const raw = control.value.trim();
    if (!raw && field.optional) { deletePath(next, field.path); continue; }
    if (field.type === 'number') {
      if (!raw) { deletePath(next, field.path); continue; }
      setPath(next, field.path, Number(raw));
    } else if (field.type === 'json') {
      if (!raw) deletePath(next, field.path);
      else {
        try { setPath(next, field.path, JSON.parse(raw)); }
        catch { throw new Error(field.path + ' 不是有效的 JSON'); }
      }
    } else if (field.type === 'list') {
      setPath(next, field.path, [...new Set(raw.split(/[\n,]+/).map(item => item.trim()).filter(Boolean))]);
    } else if (!raw && !field.required) deletePath(next, field.path);
    else setPath(next, field.path, field.type === 'select' && /^\d+$/.test(raw) && field.options?.every(([value]) => value === '' || /^\d+$/.test(value)) ? Number(raw) : raw);
  }
  return next;
}

const headers = () => ({
  'authorization': 'Bearer ' + $('token').value,
  'content-type': 'application/json',
});

const baseUrl = new URL('.',location.href);

async function api(path, options = {}) {
  const target = new URL(String(path).replace(/^\/+/,''), baseUrl);
  let r;
  try { r = await fetch(target, { ...options, headers: { ...headers(), ...(options.headers || {}) } }); }
  catch (error) { throw new Error('無法連線到 ümiro Gateway：' + (error instanceof Error ? error.message : String(error))); }
  const raw = await r.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(r.ok ? 'ümiro Gateway 回傳了無法解讀的回應' : (raw.trim() || r.statusText)); }
  if (!r.ok) throw new Error(data.error || raw.trim() || r.statusText);
  return data;
}

async function usage() {
  $('usage').textContent = JSON.stringify(await api('/api/usage'), null, 2);
}

async function logs() {
  $('logs').textContent = JSON.stringify(await api('/api/logs?limit=100'), null, 2);
}

function renderRuntime(runtime) {
  $('runtime').textContent = JSON.stringify(runtime, null, 2);
  const checks = runtime.readiness || {};
  const cards = [
    ['Gateway', runtime.ready ? '正常' : '需要處理', 'PID ' + (runtime.pid ?? '—')],
    ['Discord', checks.discord ? '已連線' : '未連線', runtime.bot?.tag || '尚無 Bot'],
    ['Storage', checks.storage ? '正常' : '異常', '資料持久層'],
    ['Scheduler', checks.scheduler ? '正常' : '異常', '排程服務'],
    ['版本', runtime.release?.revision || runtime.release?.releaseId || 'source', runtime.release?.mode || 'source'],
    ['啟動時間', runtime.startedAt ? new Date(runtime.startedAt).toLocaleString() : '—', runtime.plugins?.length + ' 個外掛'],
  ];
  $('runtimeCards').replaceChildren(...cards.map(([label, value, detail]) => {
    const card = document.createElement('div'); card.className = 'stat-card';
    const title = document.createElement('small'); title.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = value;
    const meta = document.createElement('small'); meta.textContent = detail;
    card.append(title, strong, meta); return card;
  }));
  $('connectionBadge').className = 'badge ' + (runtime.ready ? 'badge-success' : 'badge-warning');
  $('connectionBadge').textContent = runtime.ready ? '運作中' : '需要處理';
}

function emptyState(title, detail, actionLabel, action) {
  const box = document.createElement('div'); box.className = 'empty-state';
  const strong = document.createElement('strong'); strong.textContent = title; box.append(strong);
  const text = document.createElement('small'); text.textContent = detail; box.append(text);
  if (actionLabel && action) { const button = document.createElement('button'); button.textContent = actionLabel; button.onclick = action; box.append(button); }
  return box;
}

const channelName = id => {
  const x = channelCatalog.get(id);
  return x ? x.guildName + ' · ' + (x.kind === 'thread' && x.parentName ? x.parentName + ' / ' : '') + '#' + x.name : id || '未指定頻道';
};

async function untrackChannel(channel, event, button) {
  event.stopPropagation();
  const label = channelName(channel.id);
  if (!await confirmAction('停止追蹤頻道', '要停止追蹤「' + label + '」嗎？目前對話會封存，之後其他人的一般聊天不再記錄；歷史不會刪除。未來再次 @ Umiro 時，這個頻道會重新加入。若要永久忽略，請另外加入 ignoredChannels。', '停止追蹤')) return;
  await withBusy(button, async () => {
    const result = await api('/api/channels/' + encodeURIComponent(channel.id) + '/tracking', { method: 'DELETE' });
    if (selectedChannelId === channel.id) { selectedChannelId = undefined; $('channelConversation').replaceChildren(); }
    await channels();
    showToast(result.tracked ? '已停止追蹤 ' + label + '；歷史仍保留。' : '這個頻道已不在追蹤清單；歷史仍保留。', 'success');
  }, '處理中…').catch(reportError);
}

async function channels() {
  const items = await api('/api/channels');
  channelCatalog = new Map(items.map(x => [x.id, x]));
  const guilds = new Map();
  for (const item of items) {
    const guildId = item.guildId || 'dm:' + (item.transport || 'discord');
    if (!guilds.has(guildId)) guilds.set(guildId, { label: item.guildName || '私訊', channels: new Map() });
    const guild = guilds.get(guildId);
    const isThread = item.kind === 'thread';
    const channelId = isThread ? (item.parentId || 'parent:' + (item.parentName || item.id)) : item.id;
    const channelName = isThread ? (item.parentName || item.parentId || '上層頻道') : (item.name || item.id);
    if (!guild.channels.has(channelId)) guild.channels.set(channelId, { label: channelName, item: undefined, threads: new Map() });
    const channel = guild.channels.get(channelId);
    if (isThread) channel.threads.set(item.id, item);
    else channel.item = item;
  }
  const tree = document.createElement('div');
  tree.className = 'conversation-tree';
  const branch = (label, children, open = false) => {
    const details = document.createElement('details');
    details.open = open;
    const summary = document.createElement('summary');
    summary.textContent = label;
    details.append(summary, ...children);
    return details;
  };
  const channelRow = (x, labelOverride) => {
    const d = document.createElement('div');
    d.className = 'channel';
    d.dataset.channelId = x.id;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'channel-select';
    select.setAttribute('aria-label', '檢視 ' + channelName(x.id));
    const name = document.createElement('span');
    name.textContent = labelOverride || channelName(x.id);
    select.append(name);
    select.onclick = () => selectChannel(x.id, d).catch(reportError);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'channel-untrack';
    stop.textContent = '停止追蹤';
    stop.title = '停止追蹤 ' + channelName(x.id);
    stop.setAttribute('aria-label', '停止追蹤 ' + channelName(x.id));
    stop.onclick = event => untrackChannel(x, event, stop);
    d.append(select, stop);
    return d;
  };
  for (const guild of guilds.values()) {
    const channelNodes = [];
    for (const channel of guild.channels.values()) {
      const children = channel.item ? [channelRow(channel.item, '目前對話')] : [];
      for (const thread of channel.threads.values()) children.push(channelRow(thread, thread.name || thread.id));
      channelNodes.push(branch(channel.label, children, true));
    }
    tree.append(branch(guild.label, channelNodes, true));
  }
  $('channels').replaceChildren(tree);
  if (items.length === 0) $('channels').append(emptyState('尚無 Discord 頻道紀錄', '請先在 Discord 頻道觸發一次對話，該頻道才會出現在這裡。', '重新取得', () => withBusy($('refreshChannels'), channels)));
  const selected = $('scheduleChannel').value;
  $('scheduleChannel').replaceChildren(
    new Option('不指定 Discord 頻道', ''),
    ...items.map(x => new Option(channelName(x.id) + ' — ' + x.id, x.id)),
  );
  $('scheduleChannel').value = selected;
  await Promise.all([runs(), schedules()]);
  if (selectedChannelId) {
    const el = document.querySelector('#channels .channel[data-channel-id="' + CSS.escape(selectedChannelId) + '"]');
    if (el) await showChannelConversation(selectedChannelId, el);
  }
}

async function selectChannel(channelId, element) {
  const target = $('channelConversation');
  if (selectedChannelId === channelId) {
    selectedChannelId = undefined;
    element.classList.remove('active');
    target.replaceChildren();
    return;
  }
  await showChannelConversation(channelId, element);
}

async function showChannelConversation(channelId, element) {
  const target = $('channelConversation');
  selectedChannelId = channelId;
  for (const el of document.querySelectorAll('#channels .channel.active')) el.classList.remove('active');
  element.classList.add('active');
  target.replaceChildren();
  const items = await api('/api/conversations?scope=' + encodeURIComponent('discord:' + channelId) + '&state=active');
  if (items.length === 0) {
    const empty = document.createElement('small');
    empty.textContent = '這個頻道目前沒有進行中的對話';
    target.append(empty);
    return;
  }
  await renderConversation(target, items[0]);
}

const STARTER_PREFIXES = ['[System] This is the initial message of thread', '[System] This is the initial message of forum post'];

function formatMsgTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hh + ':' + mm;
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  return MM + '-' + DD + ' ' + hh + ':' + mm;
}

function replyStateBadge(state) {
  const labels = { failed: '失敗', cancelled: '已取消', timed_out: '逾時', waiting: '等待中', running: '執行中', queued: '排隊中' };
  const classes = { failed: 'badge-danger', waiting: 'badge-warning', running: 'badge-info', queued: 'badge-info' };
  const badge = document.createElement('span');
  badge.className = 'badge' + (classes[state] ? ' ' + classes[state] : '');
  badge.textContent = labels[state] || state;
  return badge;
}

function renderMessage(msg) {
  const nodes = [];
  if (msg.sequence === 0 && STARTER_PREFIXES.some(prefix => msg.text.startsWith(prefix))) {
    const el = document.createElement('div');
    el.className = 'msg starter';
    const title = document.createElement('div');
    title.className = 'msg-title';
    title.textContent = '串的第一則';
    const body = document.createElement('div');
    body.className = 'msg-text';
    const newlineIndex = msg.text.indexOf('\n');
    body.textContent = newlineIndex >= 0 ? msg.text.slice(newlineIndex + 1) : '';
    el.append(title, body);
    nodes.push(el);
    return nodes;
  }

  const el = document.createElement('div');
  el.className = 'msg user' + (msg.observed ? ' observed' : '');
  const head = document.createElement('div');
  head.className = 'msg-head';
  const name = document.createElement('span');
  name.className = 'msg-name';
  name.textContent = msg.author.displayName || msg.author.principalId;
  head.append(name);
  if (msg.isStarter) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '串的第一則';
    head.append(badge);
  }
  if (msg.author.isOwner) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Owner';
    head.append(badge);
  }
  if (msg.author.isBot) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Bot';
    head.append(badge);
  }
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = formatMsgTime(msg.at);
  head.append(time);
  const body = document.createElement('div');
  body.className = 'msg-text';
  body.textContent = msg.text;
  el.append(head, body);
  if (msg.attachments && msg.attachments.length) {
    const att = document.createElement('small');
    att.textContent = '📎 ' + msg.attachments.length + ' 個附件';
    el.append(att);
  }
  nodes.push(el);

  if (msg.reply) {
    const reply = document.createElement('div');
    reply.className = 'msg assistant';
    const rhead = document.createElement('div');
    rhead.className = 'msg-head';
    const rname = document.createElement('span');
    rname.className = 'msg-name';
    rname.textContent = 'ümiro';
    rhead.append(rname);
    const botBadge = document.createElement('span');
    botBadge.className = 'badge';
    botBadge.textContent = 'Bot';
    rhead.append(botBadge);
    if (msg.reply.state === 'succeeded') {
      const rtime = document.createElement('span');
      rtime.className = 'msg-time';
      rtime.textContent = formatMsgTime(msg.reply.at);
      rhead.append(rtime);
    } else {
      rhead.append(replyStateBadge(msg.reply.state));
    }
    reply.append(rhead);
    if (msg.reply.state === 'succeeded' && msg.reply.text) {
      const rbody = document.createElement('div');
      rbody.className = 'msg-text';
      rbody.textContent = msg.reply.text;
      reply.append(rbody);
    }
    if (msg.reply.usage) {
      const usage = document.createElement('small');
      usage.className = 'msg-usage';
      usage.textContent = msg.reply.usage.inputTokens + ' in / ' + msg.reply.usage.outputTokens + ' out';
      reply.append(usage);
    }
    nodes.push(reply);
  }
  return nodes;
}

async function renderConversation(container, summary) {
  container.replaceChildren();

  const header = document.createElement('div');
  header.className = 'chat-header';
  const title = document.createElement('strong');
  title.textContent = summary.scope?.name || summary.scope?.externalId || '目前對話';
  const meta = document.createElement('small');
  meta.textContent = summary.turnCount + ' 則 · 開始於 ' + new Date(summary.createdAt).toLocaleString();
  header.append(title, meta);

  const chat = document.createElement('div');
  chat.className = 'chat';

  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.textContent = '載入更多';
  loadMoreBtn.hidden = true;

  container.append(header, chat, loadMoreBtn);

  let after;
  async function loadPage() {
    const query = 'limit=200' + (after !== undefined ? '&after=' + after : '');
    const data = await api('/api/conversations/' + encodeURIComponent(summary.id) + '/messages?' + query);
    if (after === undefined && data.starter) {
      const starter = document.createElement('div');
      starter.className = 'msg starter';
      const title = document.createElement('div');
      title.className = 'msg-title';
      title.textContent = '串的第一則 · ' + data.starter.authorName;
      if (data.starter.authorBot) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Bot';
        title.append(badge);
      }
      const body = document.createElement('div');
      body.className = 'msg-text';
      body.textContent = data.starter.content || (data.starter.attachmentCount ? '（無文字 · ' + data.starter.attachmentCount + ' 個附件）' : '（無文字）');
      starter.append(title, body);
      chat.append(starter);
    }
    for (const msg of data.messages) {
      chat.append(...renderMessage(msg));
      after = msg.sequence;
    }
    loadMoreBtn.hidden = !data.hasMore;
  }
  loadMoreBtn.onclick = () => withBusy(loadMoreBtn, loadPage, '載入中…').catch(reportError);
  await loadPage();
}

async function archived() {
  const items = await api('/api/conversations?state=archived&limit=200');
  $('archivedConversation').replaceChildren();
  if (items.length === 0) {
    $('archivedList').replaceChildren(emptyState('尚無封存對話', '使用 Discord 的 /new 開始新對話後，舊對話會出現在這裡。'));
    return;
  }
  const guilds = new Map();
  for (const x of items) {
    const scope = x.scope;
    const guildId = scope.guildId || 'dm:' + scope.transport;
    if (!guilds.has(guildId)) guilds.set(guildId, { label: scope.guildName || '私訊', channels: new Map() });
    const guild = guilds.get(guildId);
    const isThread = scope.kind === 'thread';
    const channelId = isThread ? (scope.parentId || 'parent:' + (scope.parentName || scope.externalId)) : scope.externalId;
    const channelName = isThread ? (scope.parentName || scope.parentId || '上層頻道') : (scope.name || scope.externalId);
    if (!guild.channels.has(channelId)) guild.channels.set(channelId, { label: channelName, conversations: [], threads: new Map() });
    const channel = guild.channels.get(channelId);
    if (isThread) {
      if (!channel.threads.has(scope.externalId)) channel.threads.set(scope.externalId, { label: scope.name || scope.externalId, conversations: [] });
      channel.threads.get(scope.externalId).conversations.push(x);
    } else channel.conversations.push(x);
  }
  const tree = document.createElement('div');
  tree.className = 'archive-tree';
  const branch = (label, children, open = false) => {
    const details = document.createElement('details');
    details.open = open;
    const summary = document.createElement('summary');
    summary.textContent = label;
    details.append(summary, ...children);
    return details;
  };
  const dateItems = conversations => conversations
    .slice()
    .sort((a, b) => archiveTimestamp(b) - archiveTimestamp(a))
    .map(x => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'archive-date';
      const timestamp = archiveTimestamp(x);
      const date = new Date(timestamp);
      button.textContent = Number.isNaN(timestamp) ? '日期不詳' : date.toLocaleDateString();
      if (!Number.isNaN(timestamp) && conversations.filter(item => archiveDateKey(item) === archiveDateKey(x)).length > 1) button.textContent += ' · ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      button.onclick = () => {
        for (const el of document.querySelectorAll('#archivedList .archive-date.active')) el.classList.remove('active');
        button.classList.add('active');
        renderConversation($('archivedConversation'), x).catch(reportError);
      };
      return button;
    });
  for (const guild of guilds.values()) {
    const channelNodes = [];
    for (const channel of guild.channels.values()) {
      const children = dateItems(channel.conversations);
      for (const thread of channel.threads.values()) children.push(branch(thread.label, dateItems(thread.conversations), true));
      channelNodes.push(branch(channel.label, children, true));
    }
    tree.append(branch(guild.label, channelNodes, true));
  }
  $('archivedList').replaceChildren(tree);
}

function archiveTimestamp(item) {
  return Date.parse(item.archivedAt || item.lastActivityAt || item.createdAt || '');
}

function archiveDateKey(item) {
  const timestamp = archiveTimestamp(item);
  return Number.isNaN(timestamp) ? 'unknown' : new Date(timestamp).toLocaleDateString();
}

function scheduleExpression() {
  if ($('scheduleKind').value === 'once') return undefined;
  if ($('scheduleFrequency').value === 'custom') return $('scheduleWhen').value.trim();
  const [hour = '9', minute = '0'] = $('scheduleTime').value.split(':');
  return Number(minute) + ' ' + Number(hour) + ' * * ' + ($('scheduleFrequency').value === 'weekly' ? $('scheduleWeekday').value : '*');
}

function scheduleInput() {
  const kind = $('scheduleKind').value;
  return { kind, ...(kind === 'cron' ? { expression: scheduleExpression() } : { at: new Date($('scheduleWhen').value).toISOString() }), timezone: $('scheduleTimezone').value };
}

function resetScheduleForm() {
  editingSchedule = undefined;
  $('scheduleName').value = '';
  $('scheduleKind').value = 'cron';
  $('scheduleFrequency').value = 'daily';
  $('scheduleTime').value = '09:00';
  $('scheduleWeekday').value = '1';
  $('scheduleWhen').value = '';
  $('schedulePrompt').value = '';
  $('scheduleChannel').value = '';
  $('scheduleChannelId').value = '';
  $('createSchedule').textContent = '建立';
  updateScheduleControls();
}

let previewTimer;
function updateScheduleControls() {
  const once = $('scheduleKind').value === 'once';
  const custom = $('scheduleFrequency').value === 'custom';
  $('scheduleWhenLabel').textContent = once ? '提醒時間' : 'Cron 表達式';
  $('scheduleFrequency').hidden = once;
  $('scheduleTime').hidden = once || custom;
  $('scheduleWeekday').hidden = once || custom || $('scheduleFrequency').value !== 'weekly';
  $('scheduleWhen').hidden = !once && !custom;
  $('scheduleWhen').type = once ? 'datetime-local' : 'text';
  $('scheduleWhen').placeholder = once ? '提醒時間' : 'Cron expression';
  for (const id of ['scheduleFrequency', 'scheduleTime', 'scheduleWeekday', 'scheduleWhen']) {
    const control = $(id);
    const field = control.closest('.form-field');
    if (field) field.hidden = control.hidden;
  }
  if ($('state').textContent !== '已連線') { $('scheduleAdvancedHint').textContent = once ? '填入時間後可預覽下次執行' : '連線後會顯示下次執行時間'; return; }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const input = scheduleInput();
      const result = await api('/api/schedules/preview', { method: 'POST', body: JSON.stringify(input) });
      $('scheduleAdvancedHint').textContent = result.nextFireAt ? '下次執行：' + new Date(result.nextFireAt).toLocaleString() + '（' + input.timezone + '）' : '不會再次執行';
    } catch (error) { $('scheduleAdvancedHint').textContent = '排程尚未完整：' + errorMessage(error); }
  }, 250);
}

function scheduleLabel(x) {
  const when = x.schedule.kind === 'once' ? new Date(x.schedule.at).toLocaleString() : x.schedule.expression;
  const destination = x.destination?.channelId ? '頻道：' + channelName(x.destination.channelId) : '未指定頻道';
  const next = x.nextFireAt ? '下次執行 ' + new Date(x.nextFireAt).toLocaleString() : '';
  return [when, x.timezone, destination, next].filter(Boolean).join(' · ');
}

function scheduleSummary(x, owner) {
  const summary = document.createElement('div'); summary.className = 'item-summary';
  const heading = document.createElement('div'); heading.className = 'item-heading';
  const name = document.createElement('strong'); name.className = 'item-title'; name.textContent = x.name;
  const state = document.createElement('span'); state.className = 'badge ' + (x.enabled ? 'badge-success' : 'badge-off'); state.textContent = x.enabled ? '啟用' : '停用';
  heading.append(state, name);
  const detail = document.createElement('small'); detail.className = 'item-detail'; detail.textContent = scheduleLabel(x) + (owner ? ' · ' + owner : '');
  summary.append(heading, detail);
  return summary;
}

function renderUserSchedule(x) {
  const d = document.createElement('div'); d.className = 'schedule';
  d.append(scheduleSummary(x));
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = x.enabled ? '停用' : '啟用'; toggle.setAttribute('aria-label', (x.enabled ? '停用' : '啟用') + '排程 ' + x.name);
  toggle.onclick = () => withBusy(toggle, async () => { await api('/api/schedules/' + encodeURIComponent(x.id), { method: 'PATCH', body: JSON.stringify({ enabled: !x.enabled }) }); await schedules(); showToast(x.enabled ? '排程已停用' : '排程已啟用', 'success'); }).catch(reportError);
  const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '編輯'; edit.onclick = () => {
    editingSchedule = x.id;
    $('scheduleName').value = x.name;
    $('scheduleKind').value = x.schedule.kind;
    $('scheduleWhen').value = x.schedule.kind === 'cron' ? x.schedule.expression : new Date(x.schedule.at).toISOString().slice(0, 16);
    $('scheduleFrequency').value = 'custom';
    $('scheduleTimezone').value = x.timezone;
    $('schedulePrompt').value = x.prompt || '';
    const destinationChannelId = x.destination?.channelId || '';
    $('scheduleChannel').value = channelCatalog.has(destinationChannelId) ? destinationChannelId : '';
    $('scheduleChannelId').value = channelCatalog.has(destinationChannelId) ? '' : destinationChannelId;
    $('createSchedule').textContent = '儲存修改';
    updateScheduleControls();
  };
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '刪除';
  remove.onclick = async () => { if (!await confirmAction('刪除排程', '確定刪除「' + x.name + '」？這個操作無法復原。', '刪除')) return; await withBusy(remove, async () => { await api('/api/schedules/' + encodeURIComponent(x.id), { method: 'DELETE' }); await schedules(); showToast('排程已刪除', 'success'); }, '刪除中…').catch(reportError); };
  d.append(toggle, edit, remove); return d;
}

function renderManagedSchedule(x, plugin) {
  const d = document.createElement('div'); d.className = 'schedule managed-schedule';
  const owner = x.owner.kind === 'plugin' ? '外掛：' + x.owner.pluginId : 'Umiro 系統';
  d.append(scheduleSummary(x, owner));
  const action = document.createElement('button'); action.type = 'button';
  if (x.owner.kind === 'plugin') {
    action.textContent = '外掛設定'; action.setAttribute('aria-label', '設定外掛排程 ' + x.name);
    action.disabled = !plugin;
    action.title = plugin ? '在外掛設定中調整排程' : '找不到已安裝的外掛設定';
    action.onclick = () => { if (plugin) configurePlugin(plugin); };
  } else {
    action.textContent = '前往設定'; action.setAttribute('aria-label', '前往系統設定 ' + x.name);
    action.disabled = x.actions.settingsTarget !== 'conversation'; action.title = action.disabled ? '此系統排程沒有可用的設定入口' : '在對話設定中調整自動封存';
    action.onclick = () => openConversationAutoArchiveSettings();
  }
  d.append(action); return d;
}

function renderScheduleGroup(container, items, emptyTitle, emptyDetail, emptyAction) {
  container.replaceChildren(...items.map(renderUserSchedule));
  if (items.length === 0) container.append(emptyState(emptyTitle, emptyDetail, emptyAction ? emptyAction.label : undefined, emptyAction ? emptyAction.action : undefined));
}

function openConversationAutoArchiveSettings() {
  location.hash = '#config';
  setTimeout(() => {
    const field = document.querySelector('[data-config-path="conversation.autoArchive.enabled"]');
    field?.scrollIntoView({ block: 'center' });
    field?.querySelector('input')?.focus();
  }, 0);
}

async function schedules() {
  const items = await api('/api/schedules');
  const user = items.filter(x => x.owner?.kind === 'user');
  const plugin = items.filter(x => x.owner?.kind === 'plugin');
  const system = items.filter(x => x.owner?.kind === 'system');
  if (plugin.length > 0 && pluginCatalog.size === 0) await loadPluginCatalog();
  renderScheduleGroup($('userSchedules'), user, '尚無我的排程', '使用上方表單建立第一個 Cron 或 Reminder。', { label: '建立第一個排程', action: () => $('scheduleName').focus() });
  $('pluginSchedules').replaceChildren(...plugin.map(x => renderManagedSchedule(x, pluginCatalog.get(x.owner.pluginId))));
  if (plugin.length === 0) $('pluginSchedules').append(emptyState('尚無外掛排程', '已安裝外掛沒有註冊可顯示的排程。'));
  $('systemSchedules').replaceChildren(...system.map(x => renderManagedSchedule(x)));
  if (system.length === 0) $('systemSchedules').append(emptyState('尚無系統排程', '目前沒有由 Umiro 核心管理的排程。'));
}

async function pluginAction(action, source, workspace, config, removeSecrets = false) {
  const payload = { action, source, workspace, config };
  if (action === 'remove' && removeSecrets === true) payload.removeSecrets = true;
  await api('/api/plugins/action', { method: 'POST', body: JSON.stringify(payload) });
  await plugins();
}

function markPluginRestartRequired(message) {
  $('pluginRestartNotice').hidden = false;
  showToast(message, 'success');
}

function pluginConfigControl(name, property, value) {
  const label = document.createElement('label'); label.className = 'modal-field'; label.textContent = property.title || name;
  let control;
  if (Array.isArray(property.enum)) {
    control = document.createElement('select');
    control.replaceChildren(...property.enum.map(item => option(String(item), String(item))));
    control.value = value === undefined ? String(property.default ?? property.enum[0] ?? '') : String(value);
  } else if (property.type === 'boolean') {
    control = document.createElement('select'); control.replaceChildren(option('true', '是'), option('false', '否')); control.value = String(value ?? property.default ?? false);
  } else if (property.type === 'number' || property.type === 'integer') {
    control = document.createElement('input'); control.type = 'number'; if (property.minimum !== undefined) control.min = String(property.minimum); if (property.maximum !== undefined) control.max = String(property.maximum); if (property.type === 'integer') control.step = '1'; const initial = value ?? property.default; if (initial !== undefined) control.value = String(initial);
  } else if (property.type === 'array' || property.type === 'object') {
    control = document.createElement('textarea'); control.value = property.type === 'array' && property.items?.type === 'string' ? (Array.isArray(value) ? value.join('\n') : '') : JSON.stringify(value ?? property.default ?? (property.type === 'array' ? [] : {}), null, 2);
  } else {
    control = document.createElement('input'); control.type = property.format === 'uri' ? 'url' : 'text'; control.value = value ?? property.default ?? '';
  }
  control.dataset.pluginConfigKey = name; control.dataset.schemaType = property.type || 'string'; control.dataset.stringArray = String(property.type === 'array' && property.items?.type === 'string');
  if (property.description) { const help = document.createElement('small'); help.textContent = property.description; label.append(control, help); } else label.append(control);
  return label;
}

function pluginSecretControl(name, required) {
  const label = document.createElement('label');
  label.className = 'modal-field';
  label.textContent = name.endsWith('_API_KEY') ? 'API Key' : name;
  const control = document.createElement('input');
  control.type = 'password';
  control.autocomplete = 'new-password';
  control.dataset.pluginSecretKey = name;
  control.placeholder = secretStatus[name] ? '已設定；留空不變' : required ? '必填' : '選填';
  const help = document.createElement('small');
  help.textContent = `${name} · ${secretStatus[name] ? '已設定' : '未設定'}；只會儲存在 secrets.env，不會回顯。`;
  label.append(control, help);
  return label;
}

function markPluginSecretsConfigured(body, names) {
  for (const control of body.querySelectorAll('[data-plugin-secret-key]')) {
    const name = control.dataset.pluginSecretKey;
    if (!names.has(name)) continue;
    secretStatus[name] = true;
    control.value = '';
    control.placeholder = '已設定；留空不變';
    const help = control.closest('label')?.querySelector('small');
    if (help) help.textContent = `${name} · 已設定；只會儲存在 secrets.env，不會回顯。`;
  }
}

async function configurePlugin(x) {
  const schema = x.manifest?.configSchema;
  const requiredSecrets = Array.isArray(x.manifest?.requiredSecrets) ? x.manifest.requiredSecrets.filter(name => typeof name === 'string' && name) : [];
  const optionalSecrets = Array.isArray(x.manifest?.optionalSecrets) ? x.manifest.optionalSecrets.filter(name => typeof name === 'string' && name && !requiredSecrets.includes(name)) : [];
  const secretNames = new Set([...requiredSecrets, ...optionalSecrets]);
  if ((!schema || schema.type !== 'object' || !schema.properties) && requiredSecrets.length + optionalSecrets.length === 0) return showToast('此外掛沒有可顯示的設定欄位', 'error');
  $('modalTitle').textContent = '設定 ' + (x.manifest?.id || sourceBaseName(x.source));
  const configControls = Object.entries(schema?.properties ?? {}).filter(([name]) => !secretNames.has(name)).map(([name, property]) => pluginConfigControl(name, property, x.config?.[name]));
  const secretControls = [...requiredSecrets.map(name => pluginSecretControl(name, true)), ...optionalSecrets.map(name => pluginSecretControl(name, false))];
  const body = $('modalBody'); body.replaceChildren(...configControls, ...secretControls);
  $('modalConfirm').textContent = '儲存設定'; $('modalBackdrop').hidden = false;
  const accepted = await new Promise(resolve => { modalResolve = resolve; });
  if (!accepted) return;
  try {
    const config = {};
    for (const control of body.querySelectorAll('[data-plugin-config-key]')) {
      const key = control.dataset.pluginConfigKey; const type = control.dataset.schemaType; const raw = control.value.trim();
      if (!raw) continue;
      if (type === 'boolean') config[key] = raw === 'true';
      else if (type === 'number' || type === 'integer') config[key] = Number(raw);
      else if (type === 'array' && control.dataset.stringArray === 'true') config[key] = raw.split(/\n|,/).map(value => value.trim()).filter(Boolean);
      else if (type === 'array' || type === 'object') config[key] = JSON.parse(raw);
      else config[key] = raw;
    }
    const secrets = Object.fromEntries([...body.querySelectorAll('[data-plugin-secret-key]')].map(control => [control.dataset.pluginSecretKey, control.value.trim()]).filter(([, value]) => value));
    await pluginAction('configure', x.source, x.workspace, config);
    if (Object.keys(secrets).length) {
      await api('/api/secrets', { method: 'PUT', body: JSON.stringify(secrets) });
      markPluginSecretsConfigured(body, new Set(Object.keys(secrets)));
    }
    markPluginRestartRequired('外掛設定已儲存，重啟後完整生效');
  } catch (error) { reportError(error); }
}

function sourceBaseName(source) {
  const last = source.replace(/\/+$/, '').split('/').pop() || source;
  return last.replace(/\.git$/, '');
}

async function confirmPluginRemoval(x) {
  $('modalTitle').textContent = '移除外掛';
  const body = $('modalBody'); body.replaceChildren();
  const message = document.createElement('p'); message.textContent = '確定移除「' + (x.manifest?.id || sourceBaseName(x.source)) + '」？外掛程式會被移除，使用者資料仍依外掛契約保存。'; body.append(message);
  const declared = [...new Set([...(Array.isArray(x.manifest?.requiredSecrets) ? x.manifest.requiredSecrets : []), ...(Array.isArray(x.manifest?.optionalSecrets) ? x.manifest.optionalSecrets : [])])].filter(name => typeof name === 'string' && secretStatus[name]);
  let removeSecrets = false;
  if (declared.length) {
    const label = document.createElement('label'); label.className = 'modal-field';
    const control = document.createElement('input'); control.type = 'checkbox'; control.checked = false; control.dataset.removePluginSecrets = 'true';
    const text = document.createElement('span'); text.textContent = '同時刪除此外掛專用 Secret';
    const help = document.createElement('small'); help.textContent = '停用不會刪除 Secret；其他外掛共用或 ümiro 核心 Secret 會保留。';
    label.append(control, text, help); body.append(label);
    removeSecrets = control.checked;
    control.addEventListener('change', () => { removeSecrets = control.checked; });
  }
  $('modalConfirm').textContent = '移除'; $('modalBackdrop').hidden = false;
  const accepted = await new Promise(resolve => { modalResolve = resolve; });
  return accepted ? removeSecrets : undefined;
}

function renderPluginRow(x) {
  const builtin = x.source.startsWith('builtin:');
  const builtinId = builtin ? x.source.slice('builtin:'.length) : undefined;
  const requiredBuiltin = ['context-files', 'memory', 'host-tools', 'discord-tools'].includes(builtinId);
  const d = document.createElement('div');
  d.className = 'plugin';

  const kind = document.createElement('span');
  kind.className = 'badge ' + (builtin ? 'badge-builtin' : 'badge-external');
  kind.textContent = builtin ? '內建' : '外掛';

  const info = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'plugin-name';
  name.textContent = builtin ? builtinId : (x.workspace || sourceBaseName(x.source));
  info.append(name);
  if (!builtin) {
    const source = document.createElement('small');
    source.textContent = x.workspace ? x.source + ' · ' + x.workspace : x.source;
    info.append(document.createElement('br'), source);
  }

  const status = document.createElement('span');
  status.className = 'badge' + (x.enabled ? '' : ' badge-off');
  status.textContent = x.enabled ? '啟用' : '停用';

  const toggle = document.createElement('button');
  toggle.textContent = x.enabled ? '停用' : '啟用';
  toggle.disabled = requiredBuiltin;
  if (toggle.disabled) toggle.title = '必要內掛：ümiro 的基本 Agent 能力不可停用';
  toggle.onclick = () => withBusy(toggle, async () => { await pluginAction(x.enabled ? 'disable' : 'enable', x.source, x.workspace); markPluginRestartRequired(x.enabled ? '外掛已停用，重啟後完整生效' : '外掛已啟用，重啟後完整生效'); }).catch(reportError);

  const configure = document.createElement('button');
  configure.textContent = '設定';
  configure.onclick = () => configurePlugin(x);

  d.append(kind, info, status, toggle, configure);
  if (!builtin) {
    const update = document.createElement('button');
    update.textContent = '更新';
    update.onclick = () => withBusy(update, async () => { await pluginAction('update', x.source, x.workspace); markPluginRestartRequired('外掛已更新，重啟後完整生效'); }, '更新中…').catch(reportError);
    const remove = document.createElement('button');
    remove.textContent = '移除';
    remove.onclick = async () => { const removeSecrets = await confirmPluginRemoval(x); if (removeSecrets === undefined) return; await withBusy(remove, async () => { await pluginAction('remove', x.source, x.workspace, undefined, removeSecrets); markPluginRestartRequired('外掛已移除，重啟後完整生效'); }, '移除中…').catch(reportError); };
    d.append(update, remove);
  }
  return d;
}

function renderPluginGroup(container, items) {
  if (items.length === 0) {
    const empty = document.createElement('small');
    container.replaceChildren(emptyState(container.id === 'pluginsExternal' ? '尚無外掛' : '尚無內掛', container.id === 'pluginsExternal' ? '貼上 GitHub HTTPS URL 或本機路徑即可安裝。' : '目前安裝沒有提供內掛。', container.id === 'pluginsExternal' ? '安裝第一個外掛' : undefined, container.id === 'pluginsExternal' ? () => $('pluginSource').focus() : undefined));
    return;
  }
  container.replaceChildren(...items.map(renderPluginRow));
}

async function plugins() {
  const items = await loadPluginCatalog();
  renderPluginGroup($('pluginsBuiltin'), items.filter(x => x.source.startsWith('builtin:')));
  renderPluginGroup($('pluginsExternal'), items.filter(x => !x.source.startsWith('builtin:')));
}

async function loadPluginCatalog() {
  const items = await api('/api/plugins');
  pluginCatalog = new Map(items.filter(x => typeof x.manifest?.id === 'string').map(x => [x.manifest.id, x]));
  return items;
}

async function runs() {
  const items = await api('/api/runs?limit=30');
  $('runs').replaceChildren(...items.map(x => {
    const d = document.createElement('div');
    d.className = 'run';
    const b = document.createElement('button');
    b.className = 'run-open';
    b.textContent = x.id;
    b.title = '查看執行詳細資料';
    b.setAttribute('aria-label', '查看執行詳細資料 ' + x.id);
    const summary = document.createElement('div'); summary.className = 'item-summary';
    const heading = document.createElement('div'); heading.className = 'item-heading';
    const state = document.createElement('span');
    const stateLabel = { succeeded: '完成', failed: '失敗', running: '執行中', queued: '排隊中', cancelled: '已取消' }[x.state] || x.state;
    state.className = 'badge ' + (x.state === 'succeeded' ? 'badge-success' : x.state === 'failed' ? 'badge-danger' : x.state === 'running' || x.state === 'queued' ? 'badge-warning' : 'badge-off');
    state.textContent = stateLabel;
    const detail = document.createElement('small'); detail.className = 'item-detail';
    detail.textContent = [x.origin, x.channelId ? channelName(x.channelId) : '', x.updatedAt].filter(Boolean).join(' · ');
    const usage = document.createElement('small'); usage.className = 'item-detail';
    if (x.usage) usage.textContent = x.usage.inputTokens + ' 輸入 · ' + x.usage.outputTokens + ' 輸出';
    heading.append(state); summary.append(heading, detail);
    if (x.usage) summary.append(usage);
    b.onclick = () => withBusy(b, async () => { $('runDetail').textContent = JSON.stringify(await api('/api/runs/' + encodeURIComponent(x.id)), null, 2); }).catch(reportError);
    d.append(b, summary);
    return d;
  }));
}

async function connect() {
  localStorage.umiroToken = $('token').value;
  const [schema, config, runtime, secrets, names, modelResult] = await Promise.all([
    api('/api/schema'),
    api('/api/config'),
    api('/api/runtime'),
    api('/api/secrets'),
    api('/api/workspace'),
    api('/api/models').catch(() => []),
  ]);
  const models = modelResult.filter(model => typeof model === 'string');
  secretStatus = secrets;
  renderConfigForm(schema, config, models);
  renderRuntime(runtime);
  $('files').replaceChildren(...names.map(n => {
    const b = document.createElement('button');
    b.dataset.filename = n;
    b.textContent = n;
    b.onclick = () => withBusy(b, () => load(n), '載入中…').catch(reportError);
    return b;
  }));
  await Promise.all([channels(), archived()]);
  await plugins();
  await discoverPluginViews();
  clearInterval(channelRefreshTimer);
  channelRefreshTimer = setInterval(() => channels().catch(() => {}), 60000);
  $('state').textContent = '已連線';
  $('state').classList.add('connected');
  showPage();
}

async function load(name) {
  if (workspaceDirty && !await confirmAction('捨棄文件變更', '目前文件有未儲存變更，確定切換檔案？', '捨棄變更')) return;
  const x = await api('/api/workspace/' + encodeURIComponent(name));
  file = name;
  for (const button of document.querySelectorAll('#files button')) button.classList.toggle('active', button.dataset.filename === name);
  $('workspaceEmptyState').hidden = true;
  $('filename').textContent = name;
  $('document').value = x.content;
  $('document').disabled = false;
  $('document').hidden = false;
  $('togglePreview').disabled = false;
  $('togglePreview').textContent = '預覽 Markdown';
  $('saveDocument').disabled = false;
  $('documentPreview').hidden = true;
  workspaceDirty = false; workspaceSavedAt = undefined;
  $('workspaceSaveState').textContent = '已載入'; $('workspaceSaveState').className = 'save-state';
  renderMarkdownPreview();
}

function renderMarkdown(target, content) {
  target.replaceChildren();
  for (const line of String(content).split('\n')) {
    let element;
    if (/^#{1,6}\s/.test(line)) { const level = Math.min(6, line.match(/^#+/)[0].length); element = document.createElement('h' + level); element.textContent = line.replace(/^#{1,6}\s+/, ''); }
    else if (/^[-*]\s/.test(line)) { element = document.createElement('div'); element.textContent = '• ' + line.replace(/^[-*]\s+/, ''); }
    else { element = document.createElement('div'); element.textContent = line || ' '; }
    target.append(element);
  }
}

function renderMarkdownPreview() { renderMarkdown($('documentPreview'), $('document').value); }

const pluginViewIdPattern = /^[A-Za-z0-9._:-]{1,160}$/;
const pluginViews = new Map();
const pluginViewSelection = new Map();

function pluginPageId(viewId) { return 'page-plugin-view-' + viewId; }
function pluginHashId(viewId) { return 'plugin-view-' + viewId; }
function pluginApiPath(viewId, documentId) { return '/api/plugin-views/' + encodeURIComponent(viewId) + '/documents' + (documentId === undefined ? '' : '/' + encodeURIComponent(documentId)); }
function pluginViewMessage(view, message, type = 'info') {
  const state = view.querySelector('[data-plugin-view-state]');
  if (state) { state.textContent = message; state.className = 'plugin-view-state ' + type; }
}
function setPluginDocumentEditing(page, editing) {
  const content = page.querySelector('[data-plugin-document-content]');
  const editor = page.querySelector('[data-plugin-editor]');
  const edit = page.querySelector('[data-plugin-document-edit]');
  if (content) content.hidden = editing;
  if (editor) editor.hidden = !editing;
  if (edit) edit.hidden = editing || page.dataset.pluginWritable !== 'true';
}
function createPluginViewPage(metadata) {
  if (!metadata || typeof metadata !== 'object' || !pluginViewIdPattern.test(metadata.id) || typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.kind !== 'markdown-collection' || typeof metadata.writable !== 'boolean') return undefined;
  const viewId = metadata.id;
  const page = document.createElement('section'); page.id = pluginPageId(viewId); page.className = 'page'; page.dataset.pluginViewId = viewId; page.dataset.pluginWritable = String(metadata.writable); page.dataset.title = metadata.title.trim();
  const heading = document.createElement('div'); heading.className = 'page-actions';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '重新整理'; refresh.dataset.pluginRefresh = viewId;
  heading.append(refresh); page.append(heading);
  const state = document.createElement('p'); state.dataset.pluginViewState = 'true'; state.className = 'plugin-view-state'; state.textContent = '尚未載入'; page.append(state);
  const layout = document.createElement('div'); layout.className = 'plugin-view-layout';
  const list = document.createElement('div'); list.className = 'plugin-document-list'; list.dataset.pluginDocumentList = viewId;
  const article = document.createElement('article'); article.className = 'plugin-document';
  const documentHeading = document.createElement('div'); documentHeading.className = 'plugin-document-heading';
  const articleTitle = document.createElement('h3'); articleTitle.dataset.pluginDocumentTitle = viewId; articleTitle.textContent = '尚未選擇文件';
  const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '編輯'; edit.dataset.pluginDocumentEdit = viewId; edit.hidden = true;
  documentHeading.append(articleTitle, edit);
  const content = document.createElement('div'); content.className = 'markdown-preview'; content.dataset.pluginDocumentContent = viewId;
  article.append(documentHeading, content);
  const editor = document.createElement('div'); editor.className = 'plugin-editor'; editor.dataset.pluginEditor = viewId; editor.hidden = true;
  const textarea = document.createElement('textarea'); textarea.dataset.pluginDocumentEditor = viewId; textarea.setAttribute('aria-label', metadata.title + '內容');
  const editorActions = document.createElement('div'); editorActions.className = 'plugin-editor-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  const save = document.createElement('button'); save.type = 'button'; save.textContent = '儲存'; save.dataset.pluginDocumentSave = viewId;
  edit.onclick = () => { setPluginDocumentEditing(page, true); textarea.focus(); };
  cancel.onclick = () => { const selected = pluginViewSelection.get(viewId); if (selected) selectPluginDocument(viewId, selected).catch(error => pluginViewMessage(page, errorMessage(error), 'error')); };
  save.onclick = () => withBusy(save, async () => { const selected = pluginViewSelection.get(viewId); if (!selected) return; await api(pluginApiPath(viewId, selected), { method: 'PUT', body: JSON.stringify({ content: textarea.value }) }); await selectPluginDocument(viewId, selected); pluginViewMessage(page, '已儲存', 'success'); }, '儲存中…').catch(error => pluginViewMessage(page, errorMessage(error), 'error'));
  editorActions.append(cancel, save); editor.append(textarea, editorActions); article.append(editor); layout.append(list, article); page.append(layout);
  refresh.onclick = () => loadPluginView(viewId).catch(error => pluginViewMessage(page, errorMessage(error), 'error'));
  return page;
}
async function loadPluginView(viewId) {
  const page = pluginViews.get(viewId)?.page;
  if (!page) return;
  pluginViewMessage(page, '載入中…');
  try {
    const documents = await api(pluginApiPath(viewId));
    if (!Array.isArray(documents)) throw new Error('文件清單格式無效');
    const list = page.querySelector('[data-plugin-document-list]');
    const selected = pluginViewSelection.get(viewId);
    list.replaceChildren(...documents.map(documentSummary => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'plugin-document-item'; button.dataset.documentId = documentSummary.id;
      const occurredDate = typeof documentSummary.occurredAt === 'string' ? documentSummary.occurredAt.slice(0, 10) : '';
      button.textContent = documentSummary.title + (occurredDate && occurredDate !== documentSummary.title ? ' · ' + occurredDate : '');
      button.onclick = () => selectPluginDocument(viewId, documentSummary.id).catch(error => pluginViewMessage(page, errorMessage(error), 'error'));
      return button;
    }));
    if (!documents.length) { page.querySelector('[data-plugin-document-title]').textContent = '沒有文件'; page.querySelector('[data-plugin-document-content]').replaceChildren(); pluginViewMessage(page, '目前沒有可閱讀的文件'); return; }
    const next = documents.some(item => item.id === selected) ? selected : documents[0].id;
    await selectPluginDocument(viewId, next);
    pluginViewMessage(page, '已載入 ' + documents.length + ' 份文件', 'success');
  } catch (error) { pluginViewMessage(page, errorMessage(error), 'error'); throw error; }
}
async function selectPluginDocument(viewId, documentId) {
  if (!pluginViewIdPattern.test(viewId) || !pluginViewIdPattern.test(documentId)) throw new Error('文件識別碼無效');
  const entry = pluginViews.get(viewId); if (!entry) return;
  const document = await api(pluginApiPath(viewId, documentId));
  if (!document || document.id !== documentId || typeof document.content !== 'string') throw new Error('文件格式無效');
  pluginViewSelection.set(viewId, documentId);
  entry.page.querySelector('[data-plugin-document-title]').textContent = document.title;
  renderMarkdown(entry.page.querySelector('[data-plugin-document-content]'), document.content);
  const editor = entry.page.querySelector('[data-plugin-document-editor]'); if (editor) editor.value = document.content;
  setPluginDocumentEditing(entry.page, false);
  for (const button of entry.page.querySelectorAll('[data-document-id]')) button.classList.toggle('active', button.dataset.documentId === documentId);
}
function rebuildPluginViews(metadata) {
  const navSection = $('pluginNavSection'); const nav = $('pluginNavLinks');
  for (const entry of pluginViews.values()) { entry.page.remove(); entry.link.remove(); }
  pluginViews.clear(); nav.replaceChildren();
  const safe = Array.isArray(metadata) ? metadata.filter(item => item && typeof item === 'object' && pluginViewIdPattern.test(item.id) && typeof item.title === 'string' && item.kind === 'markdown-collection' && typeof item.writable === 'boolean') : [];
  for (const item of safe) {
    const page = createPluginViewPage(item); if (!page) continue;
    const link = document.createElement('a'); link.href = '#' + pluginHashId(item.id); link.dataset.page = pluginHashId(item.id); link.textContent = item.title.trim(); link.className = 'nav-subitem'; link.onclick = event => guardNavigation(event, link);
    nav.append(link); document.querySelector('.content').append(page);
    pluginViews.set(item.id, { page, link });
  }
  navSection.hidden = pluginViews.size === 0;
}
async function discoverPluginViews() { rebuildPluginViews(await api('/api/plugin-views')); showPage(); }

$('connect').onclick = () => withBusy($('connect'), connect, '連線中…').catch(error => { $('state').textContent = errorMessage(error); $('state').classList.remove('connected'); reportError(error); });
$('saveConfig').onclick = () => withBusy($('saveConfig'), async () => {
  try {
    const next = readConfigForm();
    const result = await api('/api/config', { method: 'PUT', body: JSON.stringify(next) });
    const secretFields = configFields().filter(field => field.type === 'secret');
    const secretValues = Object.fromEntries(secretFields.map(field => [field.secretName, $(fieldId(field.path))?.value.trim()]).filter(([, value]) => value));
    let secretResult = { restartRequired: [] };
    if (Object.keys(secretValues).length) {
      secretResult = await api('/api/secrets', { method: 'PUT', body: JSON.stringify(secretValues) });
      for (const field of secretFields.filter(candidate => Object.hasOwn(secretValues, candidate.secretName))) {
        secretStatus[field.secretName] = field.publicValue ? secretValues[field.secretName] : true;
        const control = $(fieldId(field.path));
        if (!field.publicValue) control.value = '';
        control.placeholder = '已設定；留空不變';
      }
    }
    loadedConfig = next; markConfigSaved();
    const restartRequired = [...new Set([...(result.restartRequired ?? []), ...(secretResult.restartRequired ?? [])])];
    $('restartGateway').hidden = !restartRequired.length;
    const messages = [...(result.applied?.length ? ['即時套用：' + result.applied.join('、')] : []), ...(restartRequired.length ? ['需重啟：' + restartRequired.join('、')] : [])];
    showToast('設定已儲存' + (messages.length ? '；' + messages.join('；') : ''), 'success');
  } catch (error) { reportError(error); }
}, '儲存中…');
$('saveDocument').onclick = () => withBusy($('saveDocument'), async () => { if (!file) return showToast('請先選擇文件', 'error'); try { await api('/api/workspace/' + encodeURIComponent(file), { method: 'PUT', body: JSON.stringify({ content: $('document').value }) }); workspaceDirty = false; workspaceSavedAt = new Date(); $('workspaceSaveState').textContent = '最後儲存：' + workspaceSavedAt.toLocaleTimeString(); $('workspaceSaveState').className = 'save-state saved'; showToast(file + ' 已儲存', 'success'); } catch (error) { reportError(error); } }, '儲存中…');
$('refreshSchedules').onclick = () => withBusy($('refreshSchedules'), schedules).catch(reportError);
$('createSchedule').onclick = () => withBusy($('createSchedule'), async () => {
  const kind = $('scheduleKind').value;
  let schedule;
  try { schedule = scheduleInput(); } catch { return showToast('請填入有效的提醒時間', 'error'); }
  const manualChannelId = $('scheduleChannelId').value.trim();
  if (manualChannelId && !/^[0-9]{2,32}$/.test(manualChannelId)) return showToast('頻道 ID 必須是 2–32 位數字', 'error');
  const body = {
    name: $('scheduleName').value,
    kind,
    expression: schedule.expression,
    at: schedule.at,
    timezone: $('scheduleTimezone').value,
    prompt: $('schedulePrompt').value,
    channelId: manualChannelId || $('scheduleChannel').value || undefined,
  };
  const path = editingSchedule ? '/api/schedules/' + encodeURIComponent(editingSchedule) : '/api/schedules';
  try { await api(path, { method: editingSchedule ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    resetScheduleForm();
    await schedules(); showToast('排程已儲存', 'success');
  } catch (error) { reportError(error); }
}, '儲存中…');
$('refreshPlugins').onclick = () => withBusy($('refreshPlugins'), plugins).catch(reportError);
$('installPlugin').onclick = () => withBusy($('installPlugin'), async () => { try { await pluginAction('install', $('pluginSource').value, $('pluginWorkspace').value || undefined); $('pluginSource').value = ''; $('pluginWorkspace').value = ''; markPluginRestartRequired('外掛已安裝，重啟後完整生效'); } catch (error) { reportError(error); } }, '安裝中…');
$('refreshRuns').onclick = () => withBusy($('refreshRuns'), runs).catch(reportError);
$('refreshUsage').onclick = () => withBusy($('refreshUsage'), usage).catch(reportError);
$('refreshLogs').onclick = () => withBusy($('refreshLogs'), logs).catch(reportError);
$('refreshChannels').onclick = () => withBusy($('refreshChannels'), channels).catch(reportError);
$('refreshArchived').onclick = () => withBusy($('refreshArchived'), archived).catch(reportError);
async function restartGateway() {
  if (!await confirmAction('重新啟動 Gateway', '目前進行中的工作會先嘗試安全結束，確定立即重啟？', '立即重啟')) return;
  try {
    await api('/api/runtime/restart', { method: 'POST', body: '{}' });
    showToast('Gateway 正在重新啟動', 'success');
    $('restartGateway').hidden = true;
    $('pluginRestartNotice').hidden = true;
  } catch (error) { reportError(error); }
}
$('restartGateway').onclick = restartGateway;
$('restartPlugins').onclick = restartGateway;
$('token').value = localStorage.umiroToken || '';
const selectedTheme = ['light', 'dark'].includes(localStorage.umiroTheme) ? localStorage.umiroTheme : 'system';
document.querySelector(`input[name="theme"][value="${selectedTheme}"]`).checked = true;
$('themeMode').onchange = event => {
  if (event.target.name !== 'theme') return;
  localStorage.umiroTheme = event.target.value;
  window.applyUmiroTheme(event.target.value);
};
$('scheduleTimezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
$('modalCancel').onclick = () => closeModal(false);
$('modalConfirm').onclick = () => closeModal(true);
$('modalBackdrop').onclick = event => { if (event.target === $('modalBackdrop')) closeModal(false); };
$('mobileMenu').onclick = () => {
  const open = document.querySelector('.sidebar nav').classList.toggle('mobile-open');
  $('mobileMenu').setAttribute('aria-expanded', String(open));
};
function closeMobileMenu() {
  document.querySelector('.sidebar nav').classList.remove('mobile-open');
  $('mobileMenu').setAttribute('aria-expanded', 'false');
}
document.querySelector('.sidebar nav').addEventListener('click', event => {
  if (event.target.closest('a')) closeMobileMenu();
});
document.addEventListener('click', event => {
  if (!event.target.closest('.sidebar nav, #mobileMenu')) closeMobileMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('mobileMenu').getAttribute('aria-expanded') === 'true') {
    closeMobileMenu();
    $('mobileMenu').focus();
  }
});
$('configSearch').oninput = filterConfigFields;
$('scheduleKind').onchange = updateScheduleControls;
$('scheduleFrequency').onchange = updateScheduleControls;
$('scheduleTime').oninput = updateScheduleControls;
$('scheduleWeekday').onchange = updateScheduleControls;
$('scheduleWhen').oninput = updateScheduleControls;
$('scheduleTimezone').oninput = updateScheduleControls;
$('scheduleChannel').onchange = () => { if ($('scheduleChannel').value) $('scheduleChannelId').value = ''; };
$('scheduleChannelId').oninput = () => { if ($('scheduleChannelId').value.trim()) $('scheduleChannel').value = ''; };
$('document').oninput = () => { workspaceDirty = true; markWorkspaceDirty(); if (!$('documentPreview').hidden) renderMarkdownPreview(); };
$('togglePreview').onclick = () => {
  const preview = $('documentPreview').hidden;
  if (preview) renderMarkdownPreview();
  $('documentPreview').hidden = !preview; $('document').hidden = preview;
  $('togglePreview').textContent = preview ? '編輯 Markdown' : '預覽 Markdown';
};
window.addEventListener('beforeunload', event => {
  if (configDirty || workspaceDirty) { event.preventDefault(); event.returnValue = ''; }
});
updateScheduleControls();

const pageLoaders = { channels: async () => { await Promise.all([channels(), archived()]); }, schedules, plugins, runs, usage: async () => { await Promise.all([usage(), logs()]); } };
function pages() { return [...document.querySelectorAll('.page')]; }
function navLinks() { return [...document.querySelectorAll('nav a')]; }

function currentPageName() {
  const hash = (location.hash || '#status').slice(1);
  return pages().some(p => p.id === 'page-' + hash) ? hash : 'status';
}

function showPage() {
  const name = currentPageName();
  for (const page of pages()) page.hidden = page.id !== 'page-' + name;
  for (const link of navLinks()) link.classList.toggle('active', link.dataset.page === name);
  const activePage = document.getElementById('page-' + name);
  const title = activePage?.dataset.title || activePage?.querySelector('.page-heading h2')?.textContent || '外掛檢視';
  $('currentPageTitle').textContent = title;
  document.title = 'ümiro 控制台 · ' + title;
  if ($('state').textContent === '已連線') {
    const loader = pageLoaders[name] ?? (name.startsWith('plugin-view-') ? () => loadPluginView(name.slice('plugin-view-'.length)) : undefined);
    if (loader) loader().catch(() => {});
  }
}

function guardNavigation(event, link) {
  const leavingConfig = currentPageName() === 'config' && configDirty;
  const leavingWorkspace = currentPageName() === 'workspace' && workspaceDirty;
  if (!leavingConfig && !leavingWorkspace) return;
  event.preventDefault();
  confirmAction('尚有未儲存變更', '變更會保留在本頁，但關閉或重新載入瀏覽器會遺失。仍要切換頁面？', '仍要離開').then(accepted => { if (accepted) location.hash = link.hash; });
}

window.addEventListener('hashchange', showPage);
for (const link of navLinks()) link.addEventListener('click', event => guardNavigation(event, link));
showPage();
