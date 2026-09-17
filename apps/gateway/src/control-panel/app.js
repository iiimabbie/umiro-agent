const $ = id => document.getElementById(id);
let file;
let editingSchedule;
let channelCatalog = new Map();
let channelRefreshTimer;
let selectedChannelId;
let loadedConfig;
let secretNames = [];

const CONFIG_GROUPS = [
  { title: '模型與 Context', fields: [
    { path: 'model', type: 'model', required: true },
    { path: 'protocol', type: 'select', options: [['openai_responses', 'OpenAI Responses'], ['openai_chat_completions', 'Chat Completions']] },
    { path: 'modelCapabilities', type: 'checks', wide: true, options: [['vision', '圖片理解'], ['function_tools', '工具呼叫'], ['hosted_web_search', 'Hosted Web Search'], ['hosted_image_generation', 'Hosted Image Generation'], ['hosted_code_execution', 'Hosted Code Execution']] },
    { path: 'contextMaxTokens', type: 'number', min: 256, max: 1000000, step: 1 },
    { path: 'skills', type: 'list', wide: true, placeholder: '每行一個 workspace skill 名稱' },
    { path: 'profiles', type: 'json', wide: true },
    { path: 'pricing', type: 'json', wide: true },
  ] },
  { title: 'Embedding 與跨對話記憶', fields: [
    { path: 'embedding.provider', type: 'select', options: [['disabled', '停用（只使用 FTS）'], ['gemini', 'Gemini'], ['openai-compatible', 'OpenAI-compatible']] },
    { path: 'embedding.model', type: 'text', placeholder: '例如 voyage-3.5-lite' },
    { path: 'embedding.baseUrl', type: 'url', wide: true, placeholder: 'https://api.example.com/v1' },
    { path: 'embedding.apiKeyEnv', type: 'text', placeholder: '例如 VOYAGE_API_KEY' },
    { path: 'embedding.requestsPerMinute', type: 'number', min: 1, max: 600, step: 1 },
    { path: 'embedding.recallLimit', type: 'number', min: 1, max: 20, step: 1 },
    { path: 'embedding.minSimilarity', type: 'number', min: 0, max: 1, step: 0.01 },
  ] },
  { title: 'Discord', fields: [
    { path: 'discord.ignoredChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.ambientChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.allowedChannels', type: 'list', placeholder: '每行一個 channel 或 thread ID' },
    { path: 'discord.allowedGuilds', type: 'list', placeholder: '每行一個 guild ID' },
    { path: 'discord.respondToBots', type: 'boolean' },
    { path: 'discord.queueMode', type: 'select', options: [['queue', 'Queue：等目前工作完成'], ['steer', 'Steer：併入目前工作']] },
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
  const groups = CONFIG_GROUPS.map(group => {
    const section = document.createElement('section');
    section.className = 'config-group';
    const title = document.createElement('h3');
    title.textContent = group.title;
    const grid = document.createElement('div');
    grid.className = 'config-grid';
    for (const field of group.fields) {
      const explanation = schema[field.path];
      if (!explanation) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'config-field' + (field.wide ? ' config-wide' : '');
      const label = document.createElement('label');
      label.className = 'config-label';
      label.tabIndex = 0;
      const labelText = document.createElement('span');
      labelText.textContent = explanation.label;
      const tooltip = document.createElement('span');
      tooltip.className = 'config-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.textContent = explanation.description + '\n\n預設：' + JSON.stringify(explanation.defaultValue) + '\n' + (explanation.restartRequired ? '儲存後需重啟' : '儲存後即時生效') + '\n\n風險：' + explanation.risk;
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
}

function readConfigForm() {
  const next = structuredClone(loadedConfig);
  for (const field of configFields()) {
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

const diagnostics = document.createElement('section');
diagnostics.innerHTML = '<h2>Usage／Logs</h2><button id="refreshUsage">重新整理 Usage</button><button id="refreshLogs">重新整理 Logs</button><pre id="usage"></pre><pre id="logs"></pre>';
$('page-status').appendChild(diagnostics);

const baseUrl = new URL('.',location.href);

async function api(path, options = {}) {
  const target = new URL(String(path).replace(/^\/+/,''), baseUrl);
  const r = await fetch(target, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

async function usage() {
  $('usage').textContent = JSON.stringify(await api('/api/usage'), null, 2);
}

async function logs() {
  $('logs').textContent = JSON.stringify(await api('/api/logs?limit=100'), null, 2);
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
    d.onclick = () => selectChannel(x.id, d).catch(e => alert(e.message));
    return d;
  }));
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
  selectedChannelId = channelId;
  for (const el of document.querySelectorAll('#channels .channel.active')) el.classList.remove('active');
  element.classList.add('active');
  const target = $('channelConversation');
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
  const title = document.createElement('span');
  const location = (summary.scope.parentName ? summary.scope.parentName + ' / ' : '') + '#' + (summary.scope.name || summary.scope.externalId);
  title.textContent = summary.scope.guildName ? summary.scope.guildName + ' · ' + location : location;
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
    for (const msg of data.messages) {
      chat.append(...renderMessage(msg));
      after = msg.sequence;
    }
    loadMoreBtn.hidden = !data.hasMore;
  }
  loadMoreBtn.onclick = () => loadPage().catch(e => alert(e.message));
  await loadPage();
}

async function archived() {
  const items = await api('/api/conversations?state=archived&limit=100');
  $('archivedConversation').replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('small');
    empty.textContent = '（無）';
    $('archivedList').replaceChildren(empty);
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
      for (const el of document.querySelectorAll('#archivedList .archived-item.active')) el.classList.remove('active');
      d.classList.add('active');
      renderConversation($('archivedConversation'), x).catch(e => alert(e.message));
    };
    return d;
  }));
}

async function schedules() {
  const items = await api('/api/schedules');
  $('schedules').replaceChildren(...items.map(x => {
    const d = document.createElement('div');
    d.className = 'schedule';
    const destination = x.destination?.channelId ? ' — ' + channelName(x.destination.channelId) : '';
    const label = document.createElement('span');
    label.textContent = x.name + ' — ' + JSON.stringify(x.schedule) + destination + ' — ' + (x.enabled ? '啟用' : '停用');
    const toggle = document.createElement('button');
    toggle.textContent = x.enabled ? '停用' : '啟用';
    toggle.onclick = () => api('/api/schedules/' + encodeURIComponent(x.id), { method: 'PATCH', body: JSON.stringify({ enabled: !x.enabled }) }).then(schedules);
    const edit = document.createElement('button');
    edit.textContent = '編輯';
    edit.onclick = () => {
      editingSchedule = x.id;
      $('scheduleName').value = x.name;
      $('scheduleKind').value = x.schedule.kind;
      $('scheduleWhen').value = x.schedule.kind === 'cron' ? x.schedule.expression : x.schedule.at;
      $('scheduleTimezone').value = x.timezone;
      $('schedulePrompt').value = x.input?.prompt || '';
      $('scheduleChannel').value = x.destination?.channelId || '';
      $('createSchedule').textContent = '儲存修改';
    };
    const remove = document.createElement('button');
    remove.textContent = '刪除';
    remove.onclick = () => api('/api/schedules/' + encodeURIComponent(x.id), { method: 'DELETE' }).then(schedules).catch(e => alert(e.message));
    d.append(label, toggle, edit, remove);
    return d;
  }));
}

async function pluginAction(action, source, workspace, config) {
  await api('/api/plugins/action', { method: 'POST', body: JSON.stringify({ action, source, workspace, config }) });
  await plugins();
}

function sourceBaseName(source) {
  const last = source.replace(/\/+$/, '').split('/').pop() || source;
  return last.replace(/\.git$/, '');
}

function renderPluginRow(x) {
  const builtin = x.source.startsWith('builtin:');
  const d = document.createElement('div');
  d.className = 'plugin';

  const kind = document.createElement('span');
  kind.className = 'badge ' + (builtin ? 'badge-builtin' : 'badge-external');
  kind.textContent = builtin ? '內建' : '外掛';

  const info = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'plugin-name';
  name.textContent = builtin ? x.source.slice('builtin:'.length) : (x.workspace || sourceBaseName(x.source));
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
  toggle.onclick = () => pluginAction(x.enabled ? 'disable' : 'enable', x.source, x.workspace);

  const configure = document.createElement('button');
  configure.textContent = '設定';
  configure.onclick = () => {
    const value = prompt('JSON config', JSON.stringify(x.config || {}, null, 2));
    if (value !== null) pluginAction('configure', x.source, x.workspace, JSON.parse(value)).catch(e => alert(e.message));
  };

  d.append(kind, info, status, toggle, configure);
  if (!builtin) {
    const update = document.createElement('button');
    update.textContent = '更新';
    update.onclick = () => pluginAction('update', x.source, x.workspace).catch(e => alert(e.message));
    const remove = document.createElement('button');
    remove.textContent = '移除';
    remove.onclick = () => pluginAction('remove', x.source, x.workspace).catch(e => alert(e.message));
    d.append(update, remove);
  }
  return d;
}

function renderPluginGroup(container, items) {
  if (items.length === 0) {
    const empty = document.createElement('small');
    empty.textContent = '（無）';
    container.replaceChildren(empty);
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
    b.onclick = async () => {
      $('runDetail').textContent = JSON.stringify(await api('/api/runs/' + encodeURIComponent(x.id)), null, 2);
    };
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
  renderConfigForm(schema, config, models);
  $('runtime').textContent = JSON.stringify(runtime, null, 2);
  secretNames = Object.keys(secrets);
  $('secretForm').replaceChildren(...secretNames.map(name => {
    const label = document.createElement('label');
    label.className = 'secret-field';
    label.textContent = name;
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
    b.onclick = () => load(n).catch(e => alert(e.message));
    return b;
  }));
  await channels();
  await Promise.all([plugins(), usage(), logs()]);
  clearInterval(channelRefreshTimer);
  channelRefreshTimer = setInterval(() => channels().catch(() => {}), 60000);
  $('state').textContent = '已連線';
}

async function load(name) {
  const x = await api('/api/workspace/' + encodeURIComponent(name));
  file = name;
  $('filename').textContent = name;
  $('document').value = x.content;
}

$('connect').onclick = () => connect().catch(e => $('state').textContent = e.message);
$('saveConfig').onclick = () => {
  try {
    const next = readConfigForm();
    api('/api/config', { method: 'PUT', body: JSON.stringify(next) }).then(result => {
      loadedConfig = next;
      const applied = result.applied?.length ? '\n即時套用：' + result.applied.join('、') : '';
      const restart = result.restartRequired?.length ? '\n需重啟：' + result.restartRequired.join('、') : '';
      alert('已儲存' + applied + restart);
    }).catch(e => alert(e.message));
  } catch (error) { alert(error instanceof Error ? error.message : String(error)); }
};
$('saveSecrets').onclick = () => {
  const values = Object.fromEntries(secretNames.map(name => [name, $('secret-' + name).value]).filter(([, value]) => value.trim()));
  if (!Object.keys(values).length) return alert('請填入至少一個要更新的欄位');
  api('/api/secrets', { method: 'PUT', body: JSON.stringify(values) }).then(result => {
    for (const name of Object.keys(values)) $('secret-' + name).value = '';
    const applied = result.applied?.length ? '\n即時套用：' + result.applied.join('、') : '';
    const restart = result.restartRequired?.length ? '\n需重啟：' + result.restartRequired.join('、') : '';
    alert('Secrets 已儲存' + applied + restart);
    return connect();
  }).catch(e => alert(e.message));
};
$('saveDocument').onclick = () => file ? api('/api/workspace/' + encodeURIComponent(file), { method: 'PUT', body: JSON.stringify({ content: $('document').value }) }).then(() => alert('已儲存')).catch(e => alert(e.message)) : alert('請先選檔案');
$('refreshSchedules').onclick = () => schedules().catch(e => alert(e.message));
$('createSchedule').onclick = () => {
  const kind = $('scheduleKind').value;
  const when = $('scheduleWhen').value;
  const body = {
    name: $('scheduleName').value,
    kind,
    expression: kind === 'cron' ? when : undefined,
    at: kind === 'once' ? when : undefined,
    timezone: $('scheduleTimezone').value,
    prompt: $('schedulePrompt').value,
    channelId: $('scheduleChannel').value || undefined,
  };
  const path = editingSchedule ? '/api/schedules/' + encodeURIComponent(editingSchedule) : '/api/schedules';
  api(path, { method: editingSchedule ? 'PATCH' : 'POST', body: JSON.stringify(body) }).then(() => {
    editingSchedule = undefined;
    $('createSchedule').textContent = '建立';
    return schedules();
  }).catch(e => alert(e.message));
};
$('refreshPlugins').onclick = () => plugins().catch(e => alert(e.message));
$('installPlugin').onclick = () => pluginAction('install', $('pluginSource').value, $('pluginWorkspace').value || undefined).catch(e => alert(e.message));
$('refreshRuns').onclick = () => runs().catch(e => alert(e.message));
$('refreshUsage').onclick = () => usage().catch(e => alert(e.message));
$('refreshLogs').onclick = () => logs().catch(e => alert(e.message));
$('refreshChannels').onclick = () => channels().catch(e => alert(e.message));
$('refreshArchived').onclick = () => archived().catch(e => alert(e.message));
$('token').value = localStorage.umiroToken || '';

const pages = [...document.querySelectorAll('.page')];
const navLinks = [...document.querySelectorAll('nav a')];
const pageLoaders = { channels, archived, schedules, plugins };

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
showPage();
