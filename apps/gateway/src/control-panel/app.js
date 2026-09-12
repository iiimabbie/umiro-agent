const $ = id => document.getElementById(id);
let file;
let editingSchedule;
let channelCatalog = new Map();
let channelRefreshTimer;
let selectedChannelId;

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
  const [schema, config, runtime, secrets, names, models] = await Promise.all([
    api('/api/schema'),
    api('/api/config'),
    api('/api/runtime'),
    api('/api/secrets'),
    api('/api/workspace'),
    api('/api/models').catch(e => ['模型探索失敗：' + e.message]),
  ]);
  $('help').innerHTML = Object.values(schema).map(x =>
    '<p><b>' + x.label + '</b> — ' + x.description + '<br><small>預設：' + JSON.stringify(x.defaultValue) + '；風險：' + x.risk + (x.restartRequired ? '；需重啟' : '；即時生效') + '</small></p>'
  ).join('');
  $('config').value = JSON.stringify(config, null, 2);
  $('runtime').textContent = JSON.stringify(runtime, null, 2);
  $('secrets').textContent = Object.entries(secrets).map(([name, set]) => name + '：' + (set ? '已設定' : '未設定')).join('\n');
  $('models').textContent = models.join('\n');
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
$('saveConfig').onclick = () => api('/api/config', { method: 'PUT', body: $('config').value }).then(() => alert('已儲存')).catch(e => alert(e.message));
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
