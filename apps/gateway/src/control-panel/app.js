const $ = id => document.getElementById(id);
let file;
let editingSchedule;
let channelCatalog = new Map();
let channelRefreshTimer;
let selectedChannelId;
let loadedConfig;
let secretNames = [];
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
  try { return await work(); } finally { button.disabled = false; button.textContent = original; }
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
    { path: 'embedding.baseUrl', type: 'secret', secretName: 'UMIRO_EMBEDDING_BASE_URL', wide: true, placeholder: 'https://api.example.com/v1' },
    { path: 'embedding.apiKey', type: 'secret', secretName: 'UMIRO_EMBEDDING_API_KEY', wide: true },
    { path: 'embedding.requestsPerMinute', type: 'number', min: 1, max: 600, step: 1 },
    { path: 'embedding.recallLimit', type: 'number', min: 1, max: 20, step: 1 },
    { path: 'embedding.minSimilarity', type: 'number', min: 0, max: 1, step: 0.01 },
  ] },
  { title: 'Discord', fields: [
    { path: 'discord.allowedGuilds', type: 'list', placeholder: '每行一個 guild ID' },
    { path: 'discord.allowedChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.ignoredChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.ambientChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.queueMode', type: 'select', options: [['queue', 'Queue：等目前工作完成'], ['steer', 'Steer：併入目前工作']] },
    { path: 'discord.respondToBots', type: 'boolean' },
    { path: 'discord.presence.status', type: 'select', options: [['online', 'Online'], ['idle', 'Idle'], ['dnd', 'Do Not Disturb'], ['invisible', 'Invisible']] },
    { path: 'discord.presence.activity', type: 'text', placeholder: 'Bot 名稱下方顯示的文字' },
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
const SECRET_PRESENTATION = {
  LLM_BASE_URL: { label: 'LLM Base URL', description: 'OpenAI-compatible API 的端點，例如 https://api.openai.com/v1。重新啟動 Gateway 後套用。' },
  UMIRO_EMBEDDING_API_KEY: { label: 'Embedding API Key', description: '供目前選擇的 Embedding provider 使用，密鑰只寫入 secrets.env。' },
};
const SECRET_ORDER = ['LLM_BASE_URL', 'LLM_API_KEY', 'UMIRO_EMBEDDING_API_KEY', 'DISCORD_TOKEN', 'UMIRO_OWNER_DISCORD_ID', 'UMIRO_WEB_UI_TOKEN'];
let secretStatus = {};

function configHeaderOffset() {
  return window.matchMedia('(max-width: 800px)').matches ? document.querySelector('.sidebar').getBoundingClientRect().height : 0;
}

function jumpToConfig(section) {
  const heading = section?.querySelector('h3');
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  const offset = configHeaderOffset() + document.querySelector('.config-toolbar').getBoundingClientRect().height + 12;
  window.scrollTo({ top: window.scrollY + heading.getBoundingClientRect().top - offset, behavior: 'smooth' });
}

new ResizeObserver(() => {
  document.documentElement.style.setProperty('--config-header-offset', configHeaderOffset() + 'px');
}).observe(document.querySelector('.sidebar'));

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
    if (value !== undefined && value !== null && !options.some(([raw]) => String(raw) === String(value))) options = [[String(value), String(value) + '（目前設定）'], ...options];
    select.replaceChildren(...options.map(([raw, label]) => option(raw, label)));
    select.value = value === undefined || value === null ? String(field.options?.[0]?.[0] ?? '') : String(value);
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
    input.type = 'password';
    input.autocomplete = 'new-password';
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
  const secretsButton = document.createElement('button');
  secretsButton.type = 'button';
  secretsButton.textContent = 'Secrets';
  secretsButton.onclick = () => jumpToConfig($('config-secrets'));
  nav.prepend(secretsButton);
  const groups = CONFIG_GROUPS.map((group, groupIndex) => {
    const section = document.createElement('section');
    section.className = 'config-group'; section.id = 'config-group-' + groupIndex; section.dataset.configGroup = group.title;
    const title = document.createElement('h3');
    title.textContent = group.title;
    const grid = document.createElement('div');
    grid.className = 'config-grid';
    for (const field of group.fields) {
      const explanation = schema[field.path];
      if (!explanation) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'config-field' + (field.wide ? ' config-wide' : '');
      wrapper.dataset.configPath = field.path; wrapper.dataset.configLabel = explanation.label;
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
      path.textContent = field.path;
      const value = getPath(config, field.path);
      const controlValue = value === undefined && field.type !== 'json' ? explanation.defaultValue : value;
      wrapper.append(label, path, configControl(field, controlValue, models));
      grid.append(wrapper);
    }
    section.append(title, grid);
    return section;
  });
  $('configForm').replaceChildren(...groups);
  markConfigSaved('設定已載入');
  $('configForm').oninput = markConfigDirty;
  $('configForm').onchange = markConfigDirty;
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
  for (const field of configFields()) {
    if (field.type === 'secret') continue;
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
  $('connectionBadge').className = 'badge' + (runtime.ready ? '' : ' badge-warning');
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

async function channels() {
  const items = await api('/api/channels');
  channelCatalog = new Map(items.map(x => [x.id, x]));
  $('channels').replaceChildren(...items.map(x => {
    const d = document.createElement('div');
    d.className = 'channel';
    d.dataset.channelId = x.id;
    const name = document.createElement('span');
    name.textContent = channelName(x.id);
    const id = document.createElement('small');
    id.textContent = ' — ' + x.id;
    d.append(name, id);
    d.onclick = () => selectChannel(x.id, d).catch(reportError);
    return d;
  }));
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
    if (el) await selectChannel(selectedChannelId, el);
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

const STARTER_PREFIX = '[System] This is the initial message of thread';

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
  if (msg.sequence === 0 && msg.text.startsWith(STARTER_PREFIX)) {
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
  if (msg.author.isOwner) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Owner';
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
  const meta = document.createElement('small');
  meta.textContent = summary.turnCount + ' 則 · 開始於 ' + new Date(summary.createdAt).toLocaleString();
  header.append(meta);

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
  const items = await api('/api/conversations?state=archived&limit=100');
  $('archivedConversation').replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('small');
    $('archivedList').replaceChildren(emptyState('尚無封存對話', '使用 Discord 的 /new 開始新對話後，舊對話會出現在這裡。'));
    return;
  }
  $('archivedList').replaceChildren(...items.map(x => {
    const d = document.createElement('div');
    d.className = 'archived-item';
    const location = (x.scope.parentName ? x.scope.parentName + ' / ' : '') + '#' + (x.scope.name || x.scope.externalId);
    const line1 = document.createElement('div');
    line1.textContent = x.scope.guildName ? x.scope.guildName + ' · ' + location : location;
    const line2 = document.createElement('div');
    line2.textContent = x.firstText || '（無文字）';
    const line3 = document.createElement('small');
    line3.textContent = new Date(x.createdAt).toLocaleString() + ' → ' + new Date(x.lastActivityAt).toLocaleString() + ' · ' + x.turnCount + ' 則';
    d.append(line1, line2, line3);
    d.onclick = () => {
      if (d.classList.contains('active')) {
        d.classList.remove('active');
        $('archivedConversation').replaceChildren();
        return;
      }
      for (const el of document.querySelectorAll('#archivedList .archived-item.active')) el.classList.remove('active');
      d.classList.add('active');
      renderConversation($('archivedConversation'), x).catch(reportError);
    };
    return d;
  }));
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

let previewTimer;
function updateScheduleControls() {
  const once = $('scheduleKind').value === 'once';
  const custom = $('scheduleFrequency').value === 'custom';
  $('scheduleFrequency').hidden = once;
  $('scheduleTime').hidden = once || custom;
  $('scheduleWeekday').hidden = once || custom || $('scheduleFrequency').value !== 'weekly';
  $('scheduleWhen').hidden = !once && !custom;
  $('scheduleWhen').type = once ? 'datetime-local' : 'text';
  $('scheduleWhen').placeholder = once ? '提醒時間' : 'Cron expression';
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

async function schedules() {
  const items = await api('/api/schedules');
  $('schedules').replaceChildren(...items.map(x => {
    const d = document.createElement('div');
    d.className = 'schedule';
    const destination = x.destination?.channelId ? ' — ' + channelName(x.destination.channelId) : '';
    const label = document.createElement('span');
    const next = x.nextFireAt ? ' — 下次 ' + new Date(x.nextFireAt).toLocaleString() : '';
    label.textContent = x.name + ' — ' + (x.schedule.kind === 'once' ? new Date(x.schedule.at).toLocaleString() : x.schedule.expression) + destination + next + ' — ' + (x.enabled ? '啟用' : '停用');
    const toggle = document.createElement('button');
    toggle.textContent = x.enabled ? '停用' : '啟用';
    toggle.onclick = () => withBusy(toggle, async () => { await api('/api/schedules/' + encodeURIComponent(x.id), { method: 'PATCH', body: JSON.stringify({ enabled: !x.enabled }) }); await schedules(); showToast(x.enabled ? '排程已停用' : '排程已啟用', 'success'); }).catch(reportError);
    const edit = document.createElement('button');
    edit.textContent = '編輯';
    edit.onclick = () => {
      editingSchedule = x.id;
      $('scheduleName').value = x.name;
      $('scheduleKind').value = x.schedule.kind;
      $('scheduleWhen').value = x.schedule.kind === 'cron' ? x.schedule.expression : new Date(x.schedule.at).toISOString().slice(0, 16);
      $('scheduleFrequency').value = 'custom';
      $('scheduleTimezone').value = x.timezone;
      $('schedulePrompt').value = x.input?.prompt || '';
      const destinationChannelId = x.destination?.channelId || '';
      $('scheduleChannel').value = channelCatalog.has(destinationChannelId) ? destinationChannelId : '';
      $('scheduleChannelId').value = channelCatalog.has(destinationChannelId) ? '' : destinationChannelId;
      $('createSchedule').textContent = '儲存修改';
      updateScheduleControls();
    };
    const remove = document.createElement('button');
    remove.textContent = '刪除';
    remove.onclick = async () => { if (!await confirmAction('刪除排程', '確定刪除「' + x.name + '」？這個操作無法復原。', '刪除')) return; await withBusy(remove, async () => { await api('/api/schedules/' + encodeURIComponent(x.id), { method: 'DELETE' }); await schedules(); showToast('排程已刪除', 'success'); }, '刪除中…').catch(reportError); };
    d.append(label, toggle, edit, remove);
    return d;
  }));
  if (items.length === 0) $('schedules').append(emptyState('尚無排程', '使用上方表單建立第一個 Cron 或 Reminder。', '建立第一個排程', () => $('scheduleName').focus()));
}

async function pluginAction(action, source, workspace, config) {
  await api('/api/plugins/action', { method: 'POST', body: JSON.stringify({ action, source, workspace, config }) });
  await plugins();
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

async function configurePlugin(x) {
  const schema = x.manifest?.configSchema;
  if (!schema || schema.type !== 'object' || !schema.properties) return showToast('此外掛沒有可顯示的設定欄位', 'error');
  $('modalTitle').textContent = '設定 ' + (x.manifest?.id || sourceBaseName(x.source));
  const body = $('modalBody'); body.replaceChildren(...Object.entries(schema.properties).map(([name, property]) => pluginConfigControl(name, property, x.config?.[name])));
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
    await pluginAction('configure', x.source, x.workspace, config); showToast('外掛設定已儲存，重啟後完整生效', 'success');
  } catch (error) { reportError(error); }
}

function sourceBaseName(source) {
  const last = source.replace(/\/+$/, '').split('/').pop() || source;
  return last.replace(/\.git$/, '');
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
  toggle.onclick = () => withBusy(toggle, async () => { await pluginAction(x.enabled ? 'disable' : 'enable', x.source, x.workspace); showToast(x.enabled ? '外掛已停用' : '外掛已啟用', 'success'); }).catch(reportError);

  const configure = document.createElement('button');
  configure.textContent = '設定';
  configure.onclick = () => configurePlugin(x);

  d.append(kind, info, status, toggle, configure);
  if (!builtin) {
    const update = document.createElement('button');
    update.textContent = '更新';
    update.onclick = () => withBusy(update, async () => { await pluginAction('update', x.source, x.workspace); showToast('外掛已更新', 'success'); }, '更新中…').catch(reportError);
    const remove = document.createElement('button');
    remove.textContent = '移除';
    remove.onclick = async () => { if (!await confirmAction('移除外掛', '確定移除「' + name.textContent + '」？外掛程式會被移除，使用者資料仍依外掛契約保存。', '移除')) return; await withBusy(remove, async () => { await pluginAction('remove', x.source, x.workspace); showToast('外掛已移除', 'success'); }, '移除中…').catch(reportError); };
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
  const items = await api('/api/plugins');
  renderPluginGroup($('pluginsBuiltin'), items.filter(x => x.source.startsWith('builtin:')));
  renderPluginGroup($('pluginsExternal'), items.filter(x => !x.source.startsWith('builtin:')));
}

async function runs() {
  const items = await api('/api/runs?limit=30');
  $('runs').replaceChildren(...items.map(x => {
    const d = document.createElement('div');
    d.className = 'run';
    const b = document.createElement('button');
    b.textContent = x.id;
    const location = x.channelId ? ' — ' + channelName(x.channelId) : '';
    const label = document.createElement('span');
    label.textContent = x.state + ' — ' + x.origin + location + ' — ' + x.updatedAt + (x.usage ? ' — ' + x.usage.inputTokens + ' in / ' + x.usage.outputTokens + ' out' : '');
    b.onclick = () => withBusy(b, async () => { $('runDetail').textContent = JSON.stringify(await api('/api/runs/' + encodeURIComponent(x.id)), null, 2); }).catch(reportError);
    d.append(b, label);
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
  secretNames = [...SECRET_ORDER.filter(name => !name.startsWith('UMIRO_EMBEDDING_') && Object.hasOwn(secrets, name)), ...Object.keys(secrets).filter(name => !name.startsWith('UMIRO_EMBEDDING_') && !SECRET_ORDER.includes(name)).sort()];
  $('secretForm').replaceChildren(...secretNames.map(name => {
    const presentation = SECRET_PRESENTATION[name];
    const label = document.createElement('label');
    label.className = 'secret-field';
    label.textContent = presentation?.label ?? name;
    if (presentation?.description) label.title = presentation.description;
    const input = document.createElement('input');
    input.id = 'secret-' + name;
    input.type = name === 'UMIRO_OWNER_DISCORD_ID' ? 'text' : 'password';
    input.autocomplete = 'off';
    input.placeholder = secrets[name] ? '已設定；留空不變' : '尚未設定';
    const status = document.createElement('small');
    status.textContent = secrets[name] ? '已設定' : '未設定';
    label.append(input, status);
    return label;
  }));
  $('files').replaceChildren(...names.map(n => {
    const b = document.createElement('button');
    b.textContent = n;
    b.onclick = () => withBusy(b, () => load(n), '載入中…').catch(reportError);
    return b;
  }));
  await Promise.all([channels(), archived()]);
  await plugins();
  clearInterval(channelRefreshTimer);
  channelRefreshTimer = setInterval(() => channels().catch(() => {}), 60000);
  $('state').textContent = '已連線';
}

async function load(name) {
  if (workspaceDirty && !await confirmAction('捨棄文件變更', '目前文件有未儲存變更，確定切換檔案？', '捨棄變更')) return;
  const x = await api('/api/workspace/' + encodeURIComponent(name));
  file = name;
  $('filename').textContent = name;
  $('document').value = x.content;
  workspaceDirty = false; workspaceSavedAt = undefined;
  $('workspaceSaveState').textContent = '已載入'; $('workspaceSaveState').className = 'save-state';
  renderMarkdownPreview();
}

function renderMarkdownPreview() {
  const target = $('documentPreview'); target.replaceChildren();
  for (const line of $('document').value.split('\n')) {
    let element;
    if (/^#{1,6}\s/.test(line)) { const level = Math.min(6, line.match(/^#+/)[0].length); element = document.createElement('h' + level); element.textContent = line.replace(/^#{1,6}\s+/, ''); }
    else if (/^[-*]\s/.test(line)) { element = document.createElement('div'); element.textContent = '• ' + line.replace(/^[-*]\s+/, ''); }
    else { element = document.createElement('div'); element.textContent = line || ' '; }
    target.append(element);
  }
}

$('connect').onclick = () => withBusy($('connect'), connect, '連線中…').catch(error => { $('state').textContent = errorMessage(error); reportError(error); });
$('saveConfig').onclick = () => withBusy($('saveConfig'), async () => {
  try {
    const next = readConfigForm();
    const result = await api('/api/config', { method: 'PUT', body: JSON.stringify(next) });
    const embeddingSecrets = Object.fromEntries([
      ['UMIRO_EMBEDDING_BASE_URL', $('config-embedding-baseUrl')?.value.trim()],
      ['UMIRO_EMBEDDING_API_KEY', $('config-embedding-apiKey')?.value.trim()],
    ].filter(([, value]) => value));
    let secretResult = { restartRequired: [] };
    if (Object.keys(embeddingSecrets).length) {
      secretResult = await api('/api/secrets', { method: 'PUT', body: JSON.stringify(embeddingSecrets) });
      for (const name of Object.keys(embeddingSecrets)) secretStatus[name] = true;
      $('config-embedding-baseUrl').value = '';
      $('config-embedding-apiKey').value = '';
    }
    loadedConfig = next; markConfigSaved();
    const restartRequired = [...new Set([...(result.restartRequired ?? []), ...(secretResult.restartRequired ?? [])])];
    $('restartGateway').hidden = !restartRequired.length;
    const messages = [...(result.applied?.length ? ['即時套用：' + result.applied.join('、')] : []), ...(restartRequired.length ? ['需重啟：' + restartRequired.join('、')] : [])];
    showToast('設定已儲存' + (messages.length ? '；' + messages.join('；') : ''), 'success');
  } catch (error) { reportError(error); }
}, '儲存中…');
$('saveSecrets').onclick = () => withBusy($('saveSecrets'), async () => {
  const values = Object.fromEntries(secretNames.map(name => [name, $('secret-' + name).value]).filter(([, value]) => value.trim()));
  if (!Object.keys(values).length) return showToast('請填入至少一個要更新的欄位', 'error');
  try { const result = await api('/api/secrets', { method: 'PUT', body: JSON.stringify(values) }); for (const name of Object.keys(values)) $('secret-' + name).value = ''; $('restartGateway').hidden = !(result.restartRequired?.length); showToast('Secrets 已儲存', 'success'); await connect(); } catch (error) { reportError(error); }
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
    editingSchedule = undefined;
    $('createSchedule').textContent = '建立';
    await schedules(); showToast('排程已儲存', 'success');
  } catch (error) { reportError(error); }
}, '儲存中…');
$('refreshPlugins').onclick = () => withBusy($('refreshPlugins'), plugins).catch(reportError);
$('installPlugin').onclick = () => withBusy($('installPlugin'), async () => { try { await pluginAction('install', $('pluginSource').value, $('pluginWorkspace').value || undefined); showToast('外掛已安裝，重啟後完整生效', 'success'); } catch (error) { reportError(error); } }, '安裝中…');
$('refreshRuns').onclick = () => withBusy($('refreshRuns'), runs).catch(reportError);
$('refreshUsage').onclick = () => withBusy($('refreshUsage'), usage).catch(reportError);
$('refreshLogs').onclick = () => withBusy($('refreshLogs'), logs).catch(reportError);
$('refreshChannels').onclick = () => withBusy($('refreshChannels'), channels).catch(reportError);
$('refreshArchived').onclick = () => withBusy($('refreshArchived'), archived).catch(reportError);
$('restartGateway').onclick = async () => { if (!await confirmAction('重新啟動 Gateway', '目前進行中的工作會先嘗試安全結束，確定立即重啟？', '立即重啟')) return; try { await api('/api/runtime/restart', { method: 'POST', body: '{}' }); showToast('Gateway 正在重新啟動', 'success'); $('restartGateway').hidden = true; } catch (error) { reportError(error); } };
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

const pages = [...document.querySelectorAll('.page')];
const navLinks = [...document.querySelectorAll('nav a')];
const pageLoaders = { channels: async () => { await Promise.all([channels(), archived()]); }, schedules, plugins, runs, usage: async () => { await Promise.all([usage(), logs()]); } };

function currentPageName() {
  const hash = (location.hash || '#status').slice(1);
  return pages.some(p => p.id === 'page-' + hash) ? hash : 'status';
}

function showPage() {
  const name = currentPageName();
  for (const page of pages) page.hidden = page.id !== 'page-' + name;
  for (const link of navLinks) link.classList.toggle('active', link.dataset.page === name);
  if ($('state').textContent === '已連線') {
    const loader = pageLoaders[name];
    if (loader) loader().catch(() => {});
  }
}

window.addEventListener('hashchange', showPage);
for (const link of navLinks) link.addEventListener('click', async event => {
  const leavingConfig = currentPageName() === 'config' && configDirty;
  const leavingWorkspace = currentPageName() === 'workspace' && workspaceDirty;
  if (!leavingConfig && !leavingWorkspace) return;
  event.preventDefault();
  const accepted = await confirmAction('尚有未儲存變更', '變更會保留在本頁，但關閉或重新載入瀏覽器會遺失。仍要切換頁面？', '仍要離開');
  if (accepted) location.hash = link.hash;
});
showPage();
