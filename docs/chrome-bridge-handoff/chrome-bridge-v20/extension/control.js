import { CONTROL_ORIGINS, DISCOVERY_ONLY_ORIGINS, providerForOrigin, CONTROL_ACTIONS, ControlGrants } from './permissions.js';
import { eligibleBackgroundControlTabs } from './control-targets.js';
import { requireCoordinatorAck, requestCoordinatorAck } from './coordinator-ack.js';
import { backgroundStartupDecision } from './background-mode-reconnect.js';
import { captureLocalTab } from './visual-snapshot.js';
import { loadBrowserKey, saveBrowserKey, forgetBrowserKey } from './browser-key-store.js';
import { verifyBridgeCredential } from './connection-check.js';
import { DEFAULT_ADAPTERS, mergeAdapters } from './adapters.js';
import { SelectedReadTabs } from './selected-read-tabs.js';
import { pageAction } from './page.js';
import { findSecret, redact } from './secrets.js';

const $ = (id) => document.getElementById(id);
const BRIDGE = 'http://127.0.0.1:17381';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

let running = false;
let generation = 0;
let pollAbort = null;
let audio = null;
let releaseLock = null;
const approvals = new Map();
const grants = new ControlGrants();
const timestamp = () => new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Almaty', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}).format(new Date());
function taskStatus(label, value, detail='') { $('taskState').textContent=label; $('taskProgress').value=value; $('taskTimes').textContent=timestamp() + (detail ? ' · '+detail : ''); }
function refreshGrantLabels() {
  // Individual Control grants are intentionally not offered in the site list.
  // Only the global background Control action grants temporary tab permissions.
  const global = $('controlGlobalState');
  if (global) global.textContent = !running ? 'Мост отключён; управление недоступно'
    : backgroundMode ? 'Фоновое управление: используйте общие кнопки выше (каждое действие подтверждается отдельно)'
    : $('actions').checked ? 'Глобальное разрешение действий: ВКЛ'
    : 'Глобальное разрешение действий: ВЫКЛ';
}
setInterval(refreshGrantLabels,30000);
const observedOrigins = new Map();
chrome.tabs.onUpdated.addListener((id, change) => {
  if (!change.url) return;
  const origin = new URL(change.url).origin;
  const previous = observedOrigins.get(id);
  if (previous && previous !== origin) grants.grants.delete(previous);
  observedOrigins.set(id, origin);
});

// ---------- хранилище ----------
const getSites = async () => (await chrome.storage.local.get('sites')).sites || {};
const setSites = (sites) => chrome.storage.local.set({ sites });
async function getAdapters() {
  const { adapters } = await chrome.storage.local.get('adapters');
  try { return mergeAdapters(JSON.parse(adapters || '{}')); } catch { return mergeAdapters(); }
}

// ---------- журнал ----------
const logLines = [];
function log(msg) {
  logLines.push(timestamp() + '  ' + msg);
  if (logLines.length > 80) logLines.shift();
  $('log').textContent = logLines.join('\n');
}
const setStatus = (s) => { $('status').textContent = s; };

// ---------- сайты ----------
async function renderSites() {
  const sites = await getSites();
  const perms = await chrome.permissions.getAll();
  const granted = new Set((perms.origins || []).map((o) => o.replace(/\/\*$/, '')));
  const ul = $('sites');
  ul.textContent = '';
  const entries = Object.entries(sites);
  if (!entries.length) { const li = document.createElement('li'); li.textContent = 'Сайты не добавлены.'; ul.append(li); }
  for (const [origin, s] of entries) {
    const li = document.createElement('li');
    li.dataset.origin = origin;
    const left = document.createElement('span');
    left.textContent = origin;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = (s.mode === 'chat' ? 'ИИ-чат · ' + s.adapter : 'чтение') + (s.selectedTabOnly ? ' · только выбранные вкладки' : '');
    left.append(tag);
    if (!granted.has(origin)) { const w = document.createElement('span'); w.className = 'tag'; w.textContent = 'нет разрешения Chrome'; left.append(w); }
    const rm = document.createElement('button');
    rm.className = 'secondary';
    rm.textContent = 'Убрать';
    rm.onclick = async () => {
      const cur = await getSites();
      delete cur[origin];
      grants.grants.delete(origin);
      await new SelectedReadTabs(chrome).revokeOrigin(origin);
      await setSites(cur);
      try { await chrome.permissions.remove({ origins: [origin + '/*'] }); } catch { /* уже снято */ }
      await renderSites();
    };
    li.append(left, rm);
    ul.append(li);
  }
  refreshGrantLabels();
}

function fillAdapterSelect() {
  const sel = $('adapter');
  sel.textContent = '';
  for (const [k, v] of Object.entries(DEFAULT_ADAPTERS)) { const o = document.createElement('option'); o.value = k; o.textContent = v.label; sel.append(o); }
}
$('mode').onchange = () => { $('adapterWrap').hidden = $('mode').value !== 'chat'; syncOrigin(); };
$('adapter').onchange = () => syncOrigin(true);
function syncOrigin(force = false) {
  if ($('mode').value !== 'chat') return;
  const suggestedOrigin = DEFAULT_ADAPTERS[$('adapter').value]?.origin || '';
  // Selecting an adapter fills its matching address. The field stays editable:
  // a manually entered origin is preserved until the adapter is changed again.
  if (force || !$('origin').value.trim()) $('origin').value = suggestedOrigin;
}

$('grant').onclick = async () => {
  try {
    const u = new URL($('origin').value);
    if (u.protocol !== 'https:') throw Error('Нужен HTTPS-адрес');
    if (LOCAL_HOSTS.includes(u.hostname)) throw Error('Локальные адреса запрещены');
    const ok = await chrome.permissions.request({ origins: [u.origin + '/*'] });
    if (!ok) throw Error('Chrome не выдал разрешение');
    const sites = await getSites();
    const provider = providerForOrigin(u.origin);
    const mode = provider ? $('mode').value : 'read';
    // New site enrollments are strict by default; existing sites retain their
    // previous policy until explicitly migrated.
    sites[u.origin] = mode === 'chat' ? { mode, adapter: provider, selectedTabOnly: true } : { mode, selectedTabOnly: true };
    await setSites(sites);
    $('origin').value = '';
    await renderSites();
    log('Сайт добавлен: ' + u.origin + ' (' + mode + ')');
  } catch (e) { setStatus(e.message); }
};
$('revoke').onclick = async () => {
  // Revoking site access must not stop the local bridge connection.
  grants.grants.clear();
  $('actions').checked = false;
  refreshGrantLabels();
  const p = await chrome.permissions.getAll();
  for (const o of p.origins || []) if (!o.includes('127.0.0.1')) await chrome.permissions.remove({ origins: [o] });
  await setSites({});
  await new SelectedReadTabs(chrome).clear();
  await renderSites();
  log('Все сайты отозваны');
};
// Requires a visible local user gesture and a second URL-specific confirmation.
// No read grants are created from any remote MCP request.
// Enumerate only locally in the extension panel. Remote MCP inventory remains
// restricted to tabs already individually enrolled by the user.
$('selectedReadRefresh').onclick = async () => {
  const select = $('selectedReadTabId');
  select.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Выберите вкладку';
  select.append(placeholder);
  const sites = await getSites();
  for (const tab of await chrome.tabs.query({})) {
    if (!Number.isSafeInteger(tab.id) || !tab.url) continue;
    let origin;
    try { origin = new URL(tab.url).origin; } catch { continue; }
    if (!sites[origin]?.selectedTabOnly) continue;
    if (!(await chrome.permissions.contains({ origins: [origin + '/*'] }))) continue;
    const option = document.createElement('option');
    option.value = String(tab.id);
    option.textContent = origin + ' · ' + String(tab.title || 'Без названия').slice(0, 90);
    select.append(option);
  }
  $('selectedReadStatus').textContent = (select.options.length - 1) +
    ' разрешённых для выбора вкладок. Пока чтение не предоставлено.';
};
const selectedTabId = () => {
  const id = Number($('selectedReadTabId').value);
  if (!Number.isSafeInteger(id) || id <= 0) throw Error('Некорректный tabId');
  return id;
};
$('selectedReadGrant').onclick = async () => {
  try {
    const tabId = selectedTabId();
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) throw Error('Вкладка недоступна');
    const origin = new URL(tab.url).origin;
    const site = (await getSites())[origin];
    if (!site?.selectedTabOnly) throw Error('Сначала добавьте сайт как разрешённый');
    if (!confirm('Разрешить чтение ТОЛЬКО этой вкладки на 60 минут?\\n' + tab.url))
      throw Error('Отменено пользователем');
    const granted = await new SelectedReadTabs(chrome).grant({
      tabId, expectedUrl: tab.url, localGesture: true
    });
    $('selectedReadStatus').textContent = 'Чтение tabId ' + tabId +
      ' разрешено до ' + new Date(granted.expires).toLocaleTimeString();
    await renderSites();
  } catch (e) { $('selectedReadStatus').textContent = e.message; }
};
$('selectedReadRevoke').onclick = async () => {
  try {
    const tabId = selectedTabId();
    await new SelectedReadTabs(chrome).revoke(tabId);
    $('selectedReadStatus').textContent = 'Чтение tabId ' + tabId + ' отозвано';
    await renderSites();
  } catch (e) { $('selectedReadStatus').textContent = e.message; }
};

$('saveAdapters').onclick = async () => {
  try {
    const v = JSON.parse($('adapterJson').value || '{}');
    if (typeof v !== 'object' || Array.isArray(v) || v === null) throw Error('Нужен JSON-объект');
    await chrome.storage.local.set({ adapters: JSON.stringify(v) });
    $('adapterMsg').textContent = 'Сохранено.';
  } catch (e) { $('adapterMsg').textContent = 'Ошибка: ' + e.message; }
};

// ---------- одобрения ----------
function notify() {
  const n = approvals.size;
  document.title = n ? `(${n}) Подтвердите · Chrome Bridge` : 'Chrome Bridge';
  if (n && audio) { try { const o = audio.createOscillator(); o.connect(audio.destination); o.frequency.value = 660; o.start(); o.stop(audio.currentTime + 0.15); } catch { /* звук необязателен */ } }
  if (!n) { const box = $('approvals'); if (!box.children.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Нет ожидающих запросов.'; box.append(p); } }
}
function askApproval(title, details, expires) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const box = $('approvals');
    if (!approvals.size) box.textContent = '';
    const el = document.createElement('div');
    el.className = 'approval';
    const h = document.createElement('strong'); h.textContent = title;
    const pre = document.createElement('pre'); pre.textContent = details;
    const ok = document.createElement('button'); ok.textContent = 'Разрешить';
    const no = document.createElement('button'); no.textContent = 'Отклонить'; no.className = 'danger'; no.style.marginLeft = '8px';
    el.append(h, pre, ok, no);
    box.append(el);
    const done = (fn) => (arg) => { clearTimeout(timer); approvals.delete(id); el.remove(); notify(); fn(arg); };
    const timer = setTimeout(() => done(reject)(Error('Approval timed out')), Math.max(1000, expires - Date.now() - 2000));
    ok.onclick = () => done(resolve)(true);
    no.onclick = () => done(reject)(Error('User denied action'));
    approvals.set(id, { deny: () => done(reject)(Error('Stopped')) });
    notify();
  });
}

// ---------- выполнение команд ----------
const isHttp = (u) => ['https:'].includes(u.protocol) && !LOCAL_HOSTS.includes(u.hostname);
async function siteOf(url) {
  try {
    const u = new URL(url);
    if (!isHttp(u)) return null;
    const s = (await getSites())[u.origin];
    if (!s) return null;
    if (!(await chrome.permissions.contains({ origins: [u.origin + '/*'] }))) return null;
    const provider = providerForOrigin(u.origin);
    return { ...s, origin: u.origin, mode: provider ? s.mode : 'read', adapter: provider,
      discoveryOnly: !!DISCOVERY_ONLY_ORIGINS[u.origin] };
  } catch { return null; }
}
async function inject(tabId, origin, name, args) {
  if (CONTROL_ACTIONS.has(name)) args = { ...args, controlExpires: grants.require(origin) };
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageAction, args: [name, args, origin] });
  const res = r?.result;
  if (res?.error) throw Error(res.error);
  return res;
}
async function waitComplete(tabId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await chrome.tabs.get(tabId)).status === 'complete') return true; await sleep(300); }
  return false;
}
async function tabAndSite(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) throw Error('TAB_NOT_PERMITTED');
  const site = await siteOf(tab.url);
  const current = new URL(tab.url).origin;
  const previous = observedOrigins.get(tabId);
  if (previous && previous !== current) grants.grants.delete(previous);
  observedOrigins.set(tabId, current);
  if (!site) throw Error('Tab origin is not permitted');
  if (site.selectedTabOnly === true) {
    await new SelectedReadTabs(chrome).require(tabId, tab.url);
  }
  return { tab, site };
}
async function agentTab(tabId) {
  const { tab, site } = await tabAndSite(tabId);
  if (site.mode !== 'chat') throw Error('Site is not marked as an AI chat in Chrome Bridge');
  const adapters = await getAdapters();
  const adapter = adapters[site.adapter];
  if (providerForOrigin(site.origin) !== site.adapter || adapter?.origin !== site.origin)
    throw Error('Origin-specific adapter required');
  if (!adapter) throw Error('Unknown adapter: ' + site.adapter);
  return { tab, site, adapter, adapterName: site.adapter };
}

async function execute(cmd) {
  if (Date.now() > cmd.expires) throw Error('Command expired');
  const { name, args } = cmd;
  // One global gate for every mutating action, including agent_send/new_chat/open.
  if (CONTROL_ACTIONS.has(name) && !$('actions').checked)
    throw Error('Control denied: global Grant Control is OFF');

  if (name === 'control_status') {
    const sites = await getSites();
    const globalEnabled = running && $('actions').checked;
    return {
      connected: running,
      globalEnabled,
      approvalPending: approvals.size,
      origins: Object.keys(sites).filter(origin => CONTROL_ORIGINS[origin]).map(origin => ({
        origin,
        effective: grants.status(origin, globalEnabled).allowed,
        expiresAt: grants.status(origin, globalEnabled).expiresAt
      })),
      // No token, prompt text, screenshot bytes or approval details.
    };
  }
  if (name === 'browser_tabs') {
    const out = [];
    for (const t of await chrome.tabs.query({})) {
      const site = t.url && (await siteOf(t.url));
      if (site) {
        try {
          if (site.selectedTabOnly === true) await new SelectedReadTabs(chrome).require(t.id, t.url);
          out.push({ tabId: t.id, title: t.title, url: t.url, mode: site.mode, adapter: site.adapter || null, active: t.active, windowId: t.windowId });
        } catch { /* scoped tab has not been locally enrolled */ }
      }
    }
    return out;
  }
  if (name === 'browser_open') {
    if (!(await siteOf(args.url))) throw Error('Origin not permitted: add this website in Chrome Bridge');
    if ((await getSites())[new URL(args.url).origin]?.selectedTabOnly === true)
      throw Error('SCOPED_TAB_NAVIGATION_DISABLED');
    const targetOrigin = new URL(args.url).origin;
    grants.require(targetOrigin);
    await askApproval('Открыть вкладку', 'Разрешённый адрес: ' + targetOrigin + '\\nОткрытие внешнего сайта', cmd.expires);
    if (!running || Date.now() >= cmd.expires) throw Error('Command stopped or expired');
    grants.require(targetOrigin);
    const t = await chrome.tabs.create({ url: args.url, active: !!args.active });
    return { tabId: t.id, url: args.url };
  }
  if (name === 'browser_wait') {
    const { tab, site } = await tabAndSite(args.tabId);
    const end = Date.now() + (args.timeoutMs || 10000);
    let loaded = await waitComplete(tab.id, Math.max(0, end - Date.now()));
    if (!args.selector) return { loaded };
    while (Date.now() < end) {
      const r = await inject(tab.id, site.origin, 'exists', { selector: args.selector });
      if (r.found) return { loaded, found: true };
      await sleep(300);
    }
    return { loaded, found: false };
  }
  if (name === 'browser_read') {
    const { tab, site } = await tabAndSite(args.tabId);
    if ($('confirmReads').checked) await askApproval('Чтение страницы', `${tab.url}\n${args.selector ? 'Элемент: ' + args.selector : 'Вся страница'}`, cmd.expires);
    const r = await inject(tab.id, site.origin, 'browser_read', args);
    const after = await tabAndSite(tab.id);
    if (after.tab.url !== tab.url) throw Error('TAB_CHANGED_DURING_READ');
    return { ...r, text: redact(r.text), links: r.links.map((l) => ({ text: redact(l.text), url: redact(l.url) })) };
  }
  if (name === 'browser_click' || name === 'browser_fill') {
    if (!$('actions').checked) throw Error('Actions disabled in control tab');
    if (!running) throw Error('Stopped');
    const { tab, site } = await tabAndSite(args.tabId);
    grants.require(site.origin);
    const d = await inject(tab.id, site.origin, 'describe', { selector: args.selector });
    const lines = [`Страница: ${tab.url}`, `Селектор: ${args.selector}`, `Элемент: <${d.tag}${d.type ? ' type=' + d.type : ''}> В«${d.text}В»`];
    if (d.href) lines.push('Ссылка: ' + d.href);
    if (d.formAction) lines.push('Отправляет форму на: ' + d.formAction);
    if (name === 'browser_fill') lines.push('Текст: ' + args.text.slice(0, 300) + (args.text.length > 300 ? 'вЂ¦' : ''));
    await askApproval(name === 'browser_click' ? 'Нажатие' : 'Ввод текста', lines.join('\n'), cmd.expires);
    if (!running || Date.now() > cmd.expires) throw Error('Command stopped or expired');
    return inject(tab.id, site.origin, name, { ...args, expect: { tag: d.tag, text: d.text } });
  }

  // ---- агентские чаты ----
  if (name === 'agent_probe') {
    const { tab, site, adapter, adapterName } = await agentTab(args.tabId);
    const test = await inject(tab.id, site.origin, 'agent_selftest', { adapter });
    const after = await tabAndSite(tab.id);
    if (after.tab.url !== tab.url) throw Error('TAB_CHANGED_DURING_READ');
    return { adapter: adapterName, verified: test.composer.visible === 1 && test.send.visible === 1 };

  }
  if (name === 'agent_context') {
    const { tab, site, adapter } = await agentTab(args.tabId);
    const result = await inject(tab.id, site.origin, 'agent_context', { adapter });
    const after = await tabAndSite(tab.id);
    if (after.tab.url !== tab.url) throw Error('TAB_CHANGED_DURING_READ');
    return result;
  }
  if (name === 'agent_new_chat') {
    const { tab, site, adapter } = await agentTab(args.tabId);
    if (site.discoveryOnly) throw Error('Candidate chat is discovery-only: Control not enabled');
    grants.require(site.origin);
    if (!adapter.newChatUrl || new URL(adapter.newChatUrl).origin !== new URL(tab.url).origin) throw Error('Adapter has no same-origin newChatUrl');
    await askApproval('Новый AI-чат', 'Сайт: ' + site.origin + '\\nСоздать новый разговор в существующей вкладке?', cmd.expires);
    if (!running || Date.now() >= cmd.expires) throw Error('Command stopped or expired');
    grants.require(site.origin);
    await chrome.tabs.update(tab.id, { url: adapter.newChatUrl });
    await sleep(500);
    await waitComplete(tab.id, 15000);
    await sleep(1500);
    return { ok: true };
  }
  if (['agent_send', 'agent_peek', 'agent_selftest'].includes(name)) {
    const { tab, site, adapter } = await agentTab(args.tabId);
    if (name === 'agent_send' && site.discoveryOnly)
      throw Error('Candidate chat is discovery-only: message sending is disabled until adapter calibration and approval');
    if (name === 'agent_send') {
      const secret = findSecret(args.text);
      if (secret) throw Error('Refusing to send: text looks like it contains a secret (' + secret + ')');
      grants.require(site.origin);
      const conversation = await inject(tab.id, site.origin, 'agent_context', { adapter });
      if (!conversation.verified || conversation.origin !== site.origin ||
          conversation.conversationId !== args.expectedConversationId ||
          args.expectedOrigin !== site.origin) throw Error('Conversation changed before approval');
      // Display only a short redacted preview; full prompt is not copied to logs.
      await askApproval('Отправить AI-запрос', 'Сайт: ' + site.origin +
        '\\nРазговор: ' + conversation.conversationId +
        '\\nСимволов: ' + args.text.length +
        '\\nНачало: ' + redact(args.text.slice(0, 180)), cmd.expires);
      if (!running || Date.now() >= cmd.expires) throw Error('Command stopped or expired');
      grants.require(site.origin);
      // Confirm identity after approval, not only before it.
      const current = await tabAndSite(tab.id);
      if (current.site.origin !== site.origin || current.tab.url !== tab.url)
        throw Error('AI tab changed after approval');
    }
    const result = await inject(tab.id, site.origin, name, { ...args, adapter });
    // The classic control-panel transport must enforce the same tab identity
    // after read diagnostics as the background transport.
    if (name !== 'agent_send') {
      const after = await tabAndSite(tab.id);
      if (after.tab.url !== tab.url) throw Error('TAB_CHANGED_DURING_READ');
    }
    return result?.text ? { ...result, text: redact(result.text) } : result;
  }
  throw Error('Unknown command: ' + name);
}

// ---------- long-poll цикл ----------
async function post(path, body, ms) {
  const r = await fetch(BRIDGE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + $('token').value },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(ms), pollAbort.signal]),
  });
  if (!r.ok) throw Error('Bridge HTTP ' + r.status);
  return r.json();
}
async function handle(command) {
  let result, error;
  log('→ ' + command.name);
  taskStatus('Выполняется: '+command.name, 35, 'Задание принято');
  try { result = await execute(command); } catch (e) { error = e.message; log('✗ ' + command.name + ': ' + e.message); }
  taskStatus(error ? 'Ошибка: '+command.name : 'Завершено: '+command.name, 100, error ? 'Смотрите журнал' : 'Результат подготовлен');
  try { await post('/bridge/result', { id: command.id, result, error }, 10000); }
  catch { await sleep(500); await post('/bridge/result', { id: command.id, result, error }, 10000).catch(() => {}); }
}
async function loop(gen) {
  while (running && gen === generation) {
    try {
      const { command, epoch } = await post('/bridge/poll', {}, 30000);
      if (!epoch || grants.epoch !== epoch) grants.reset(epoch || null);
      refreshGrantLabels();
      if (!running || gen !== generation) break;
      setStatus('Подключено · ожидание команд');
      if (!command && $('taskProgress').value !== 100) taskStatus('Ожидание команд',0);
      if (command) await handle(command);
    } catch (e) {
      if (!running || gen !== generation) break;
      setStatus('Ошибка: ' + e.message);
      await sleep(2000);
    }
  }
}
function stop() {
  running = false;
  grants.reset();
  refreshGrantLabels();
  generation++;
  pollAbort?.abort();
  for (const a of [...approvals.values()]) a.deny();
  if (releaseLock) { releaseLock(); releaseLock = null; }
  setStatus('Отключено');
  taskStatus('Отключено', 0);
}
$('actions').addEventListener('change', (event) => {
  if (!event.isTrusted) { $('actions').checked = false; }
  if (!$('actions').checked) grants.grants.clear();
  refreshGrantLabels();
});
let backgroundMode = false;
// Background mutation lab is ALWAYS opt-in and starts disabled.
$('mutationLab').addEventListener('change',async event=>{
  if (!event.isTrusted) { $('mutationLab').checked=false; return; }
  const enabled=$('mutationLab').checked;
  if (enabled && (!backgroundMode || !window.confirm(
    'Включить экспериментальное управление? Каждая команда потребует отдельного подтверждения, а каждая вкладка — временного разрешения Control. Продолжить?'
  ))) {
    $('mutationLab').checked=false;return;
  }
  try {
    await chrome.storage.local.set({bridgeMutationLabMode:enabled});
    if (!enabled) {
      // Disabling the lab also revokes all existing per-tab grants.
      await chrome.runtime.sendMessage({target:'bridge-coordinator',type:'clear-background-controls'});
    }
    $('backgroundGrantStatus').textContent=enabled ?
      'Лабораторный режим включён. Используйте общую кнопку Control для открытых разрешённых вкладок.' :
      'Управление отключено';
    window.dispatchEvent(new Event('bridge-background-grants-changed'));
  } catch(e) {
    $('mutationLab').checked=!enabled;
    setStatus('Ошибка настройки управления: '+e.message);
  }
});
// A single local gesture can grant *only currently open, individually approved*
// chat tabs. This does not enable wildcard host permissions or skip per-action
// approval. Each tab is revalidated by the background coordinator.
$('backgroundGrantAll').onclick=async event=>{
  if (!event.isTrusted) return;
  try {
    if (!backgroundMode || !$('mutationLab').checked || !running)
      throw Error('Сначала подключите фоновый мост и включите экспериментальное управление');
    const sites=await getSites();
    const candidates=await eligibleBackgroundControlTabs(chrome,sites,CONTROL_ORIGINS);
    if (!candidates.length) throw Error('Нет открытых вкладок разрешённых Claude, Gemini или DeepSeek');
    const minutes=Number($('backgroundGrantMinutes').value);
    if (![15,60].includes(minutes)) throw Error('Недопустимый срок разрешения');
    const summary=candidates.map(t=>t.origin+' (вкладка '+t.id+')').join('\n');
    if (!window.confirm('Разрешить Control для '+candidates.length+
      ' открытых вкладок на '+minutes+' минут?\n'+summary+
      '\nКаждое действие потребует отдельного подтверждения.')) return;
    let success=0;
    let failed=0;
    for (const tab of candidates) {
      try {
        const result=await chrome.runtime.sendMessage({
          target:'bridge-coordinator',type:'grant-background-control',
          tabId:tab.id,durationMinutes:minutes,localGesture:true
        });
        if (!result || result.error || result.origin!==tab.origin) throw Error('GRANT_FAILED');
        success++;
      } catch { failed++; }
    }
    $('backgroundGrantStatus').textContent='Общее управление: разрешено вкладок '+success+
      ', отказано '+failed+'; каждое действие подтверждается отдельно.';
    window.dispatchEvent(new Event('bridge-background-grants-changed'));
  } catch(e) {
    $('backgroundGrantStatus').textContent='Общее управление не подключено: '+e.message;
  }
};
$('backgroundRevokeAll').onclick=async event=>{
  if (!event.isTrusted || !backgroundMode) return;
  try {
    const result=await chrome.runtime.sendMessage({
      target:'bridge-coordinator',type:'clear-background-controls'
    });
    if (!result?.ok) throw Error(result?.error||'REVOKE_FAILED');
    $('backgroundGrantStatus').textContent='Управление всеми вкладками отозвано.';
    window.dispatchEvent(new Event('bridge-background-grants-changed'));
  } catch(e) {
    $('backgroundGrantStatus').textContent='Ошибка отключения: '+e.message;
  }
};
let backgroundTimer = null;
async function showBackgroundApprovals() {
  const box = $('backgroundApprovals');
  if (!backgroundMode) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  try {
    const response = await chrome.runtime.sendMessage({target:'bridge-coordinator',type:'approval-list'});
    if (response.error) throw Error(response.error);
    // Rebuild DOM safely; no HTML injection from remote command metadata.
    box.replaceChildren();
    for (const pending of response.pending || []) {
      const row=document.createElement('div');
      row.className='approval';
      const description=document.createElement('p');
      description.textContent=pending.command+' · '+pending.origin+
        ' · вкладка '+pending.tabId+' · до '+new Date(pending.expires).toLocaleTimeString()+
        ' · символов '+(pending.contentLength || 0);
      if (pending.preview) {
        const preview=document.createElement('pre');
        preview.textContent=pending.preview;
        row.append(preview);
      }
      row.append(description);
      for (const [title,approved] of [['Разрешить',true],['Отклонить',false]]) {
        const b=document.createElement('button');
        b.textContent=title;
        if (!approved) b.className='danger';
        b.addEventListener('click',async event=>{
          if (!event.isTrusted) return;
          b.disabled=true;
          const result=await chrome.runtime.sendMessage({
            target:'bridge-coordinator',type:'approval-decide',
            id:pending.id,approved,trustedUserGesture:true
          });
          if (result.error) setStatus('Подтверждение: '+result.error);
          await showBackgroundApprovals();
        });
        row.append(b);
      }
      box.append(row);
    }
    if (!box.children.length) {
      const empty=document.createElement('p');
      empty.className='hint';
      empty.textContent='Нет ожидающих фоновых подтверждений.';
      box.append(empty);
    }
  } catch (error) {
    box.textContent='Очередь подтверждений недоступна: '+error.message;
  }
}
async function updateBackgroundStatus() {
  if (!backgroundMode) return;
  try {
    const current = await chrome.runtime.sendMessage({target:'bridge-coordinator',type:'status'});
    if (!current || typeof current !== 'object' || typeof current.state !== 'string') {
      throw Error('COORDINATOR_STATUS_NO_RESPONSE');
    }
    const active = current.connected === true;
    running = active; // UI indication only; background owns the HTTP poll.
    $('actions').checked = false; // Never auto-enable Control in background mode.
    $('actions').disabled = true;
    $('backgroundModeStatus').textContent = 'Фоновый режим: чтение доступно. Отправка возможна только в экспериментальном Control с временными разрешениями и подтверждением каждого действия.';
    const labels = {
      connected:'Подключено · фоновый режим',
      connecting:'Фоновое подключение…',
      recovering:'Восстанавливаем соединение с сервером…',
      'auth-failed':'Ошибка авторизации фонового соединения',
      disconnected:'Отключено вручную'
    };
    setStatus(labels[current.state] || 'Фоновый режим: ' + current.state);
    refreshGrantLabels();
    await showBackgroundApprovals();
  } catch (e) {
    setStatus('Фоновый координатор недоступен: ' + e.message);
  }
}
async function switchToBackgroundMode() {
  // Stop the previous UI poller BEFORE authorizing a second transport owner.
  if (running && pollAbort) stop();
  backgroundMode = true;
  await chrome.storage.local.set({bridgeBackgroundMode:true});
  $('backgroundMode').checked = true;
  $('actions').checked = false;
  $('actions').disabled = true;
  const {bridgeConnectionDesired}=await chrome.storage.local.get('bridgeConnectionDesired');
  const decision=backgroundStartupDecision({
    connectionDesired:bridgeConnectionDesired,
    hasSavedKey:!!$('token').value.trim()
  });
  if (decision==='start') {
    try {
      await requestCoordinatorAck(
        ()=>chrome.runtime.sendMessage({target:'bridge-coordinator',type:'start-background'}),
        'BACKGROUND_START'
      );
    } catch (error) {
      await chrome.storage.local.set({bridgeBackgroundMode:false,bridgeConnectionDesired:false,bridgeMutationLabMode:false});
      try { await requestCoordinatorAck(()=>chrome.runtime.sendMessage({target:'bridge-coordinator',type:'stop-background'}),'BACKGROUND_STOP',{timeoutMs:3000}); } catch {}
      backgroundMode = false;
      $('backgroundMode').checked = false;
      $('mutationLab').checked = false;
      $('actions').disabled = false;
      running = false;
      throw error;
    }
  }
  if (!backgroundTimer) backgroundTimer = setInterval(updateBackgroundStatus, 2500);
  await updateBackgroundStatus();
  if (decision==='await-connect')
    setStatus('Фоновый режим включён · нажмите «Подключить» для авторизации лабораторного моста');
}
async function leaveBackgroundMode() {
  if (backgroundTimer) clearInterval(backgroundTimer);
  backgroundTimer = null;
  await chrome.storage.local.set({bridgeConnectionDesired:false,bridgeMutationLabMode:false});
  try {
    await requestCoordinatorAck(
      ()=>chrome.runtime.sendMessage({target:'bridge-coordinator',type:'stop-background'}),
      'BACKGROUND_STOP'
    );
  } catch (error) {
    // Keep the background owner selected after an uncertain stop. Do not
    // expose the legacy poller, and restore status polling for diagnosis.
    if (!backgroundTimer) backgroundTimer = setInterval(updateBackgroundStatus,2500);
    throw error;
  }
  await chrome.storage.local.set({bridgeBackgroundMode:false});
  backgroundMode = false;
  await showBackgroundApprovals();
  running = false;
  $('actions').disabled = false;
  $('backgroundMode').checked = false;
  $('mutationLab').checked = false;
  await chrome.storage.local.set({bridgeMutationLabMode:false});
  $('backgroundModeStatus').textContent = 'Обычный режим: панель управляет подключением.';
  setStatus('Отключено · нажмите «Подключить»');
}
$('backgroundMode').addEventListener('change', async event => {
  if (!event.isTrusted) { $('backgroundMode').checked = backgroundMode; return; }
  const requested = $('backgroundMode').checked;
  if (requested && !confirm('Фоновый режим поддерживает диагностику и чтение. Отправка сообщений Claude, Gemini и DeepSeek требует отдельного включения экспериментального Control, временных разрешений и подтверждения каждого действия. Включить фоновый режим?')) {
    $('backgroundMode').checked = backgroundMode;
    return;
  }
  $('backgroundMode').disabled = true;
  try {
    if (requested) await switchToBackgroundMode();
    else await leaveBackgroundMode();
  } catch (error) {
    $('backgroundMode').checked = backgroundMode;
    setStatus('Не удалось переключить режим: ' + error.message);
  } finally { $('backgroundMode').disabled = false; }
});
let reconnectTimer = null;
let reconnectAllowed = true;
const cancelReconnect = () => { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; };
$('stop').onclick = async () => {
  reconnectAllowed = false;
  cancelReconnect();
  await chrome.storage.local.set({ bridgeConnectionDesired: false, bridgeMutationLabMode: false });
  if (backgroundMode) {
    try {
      await requestCoordinatorAck(
        ()=>chrome.runtime.sendMessage({target:'bridge-coordinator',type:'stop-background'}),
        'BACKGROUND_STOP'
      );
      running = false;
      await updateBackgroundStatus();
    } catch(error) {
      running = false;
      setStatus('Фоновое отключение не подтверждено: ' + error.message);
    }
  } else stop();
};
async function connectBridge({ automatic = false } = {}) {
  if (running || $('connect').disabled) return;
  if (backgroundMode) {
    const token = $('token').value.trim();
    if (!token) { setStatus('Введите ключ браузера.'); return; }
    $('connect').disabled = true;
    try {
      await verifyBridgeCredential(fetch, token);
      await saveBrowserKey(chrome, token);
      await chrome.storage.local.set({bridgeConnectionDesired:true});
      await requestCoordinatorAck(
        ()=>chrome.runtime.sendMessage({target:'bridge-coordinator',type:'start-background'}),
        'BACKGROUND_START'
      );
      await updateBackgroundStatus();
    } catch (e) {
      await chrome.storage.local.set({bridgeConnectionDesired:false,bridgeMutationLabMode:false});
      try { await requestCoordinatorAck(()=>chrome.runtime.sendMessage({target:'bridge-coordinator',type:'stop-background'}),'BACKGROUND_STOP',{timeoutMs:3000}); } catch {}
      running = false;
      setStatus('Фоновое подключение: ' + e.message);
    }
    finally { $('connect').disabled = false; }
    return;
  }
  const token = $('token').value.trim();
  if (!token) { setStatus('Введите ключ браузера.'); return; }
  $('connect').disabled = true;
  setStatus('Проверяем авторизацию сервера (до 26 секунд)…');
  try {
    // First verify with the running server. Never persist unverified keys.
    const handshake = await verifyBridgeCredential(fetch, token);
    await saveBrowserKey(chrome, token);
    if (!automatic) await chrome.storage.local.set({ bridgeConnectionDesired: true });
    $('keyStorageStatus').textContent = 'Ключ проверен сервером и сохранён в профиле расширения.';
    grants.reset(handshake.epoch);
    pollAbort = new AbortController();
    try { audio = new AudioContext(); } catch { audio = null; }
    navigator.locks.request('chrome-bridge-control', () =>
      new Promise(resolve => { releaseLock = resolve; })).catch(() => {});
    running = true;
    refreshGrantLabels();
    setStatus('Подключено · ожидание команд');
    loop(generation);
  } catch (error) {
    const code = error.message || 'UNKNOWN';
    const hints = {
      BROWSER_KEY_REJECTED_401: 'Ключ отклонён сервером (HTTP 401). Проверьте browserToken активной конфигурации; ключ не сохранялся.',
      EXTENSION_ORIGIN_REJECTED_403: 'Сервер отклонил идентификатор расширения (HTTP 403). Проверьте extensionId в активной конфигурации.',
      BRIDGE_NETWORK_UNREACHABLE: 'Мост недоступен на 127.0.0.1:17381. Проверьте, что сервер запущен.',
      BRIDGE_TIMEOUT: 'Нет ответа от моста за 26 секунд. Проверьте сервер и попробуйте после диагностики.',
      KEY_EMPTY: 'Ключ не введён.'
    };
    setStatus(hints[code] || ('Ошибка подключения: ' + code));
    // Retry only temporary network outages, never rejected credentials or
    // extension-origin mismatches. Never re-enable page/control permissions.
    if (automatic && reconnectAllowed &&
        ['BRIDGE_NETWORK_UNREACHABLE', 'BRIDGE_TIMEOUT'].includes(code)) {
      cancelReconnect();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (reconnectAllowed && !running) void connectBridge({ automatic: true });
      }, 12000);
    }
  } finally {
    $('connect').disabled = false;
  }
}
$('connect').onclick = () => { reconnectAllowed = true; cancelReconnect(); void connectBridge(); };
$('forgetKey').onclick = async (event) => {
  if (!event.isTrusted) return;
  if (!window.confirm('Удалить сохранённый ключ браузера из Chrome Bridge и отключить мост?')) return;
  try {
    reconnectAllowed = false;
    cancelReconnect();
    if (backgroundMode) {
      await chrome.runtime.sendMessage({target:'bridge-coordinator',type:'stop-background'});
      running = false;
    } else stop();
    await chrome.storage.local.set({ bridgeConnectionDesired: false });
    await forgetBrowserKey(chrome);
    $('token').value = '';
    $('keyStorageStatus').textContent = 'Сохранённый ключ удалён. Для подключения потребуется ввести его заново.';
  } catch (error) {
    setStatus('Не удалось удалить ключ: ' + error.message);
  }
};
// Closing the panel is NOT a user disconnect request. The current UI-owned
// polling session still ends when this document is destroyed; persisted
// desired state allows reconnect on reopening until runtime is moved to a
// background-owned connection service.
window.addEventListener('beforeunload', () => {
  reconnectAllowed = false;
  cancelReconnect();
  if (!backgroundMode) stop();
});

// ---------- локальная визуальная диагностика ----------
$('visualCapture').onclick = async (event) => {
  const status = $('visualStatus');
  const preview = $('visualPreview');
  preview.src = '';
  preview.hidden = true;
  if (!event.isTrusted) { status.textContent = 'Требуется локальный клик'; return; }
  const tabId = Number($('visualTabId').value);
  if (!Number.isSafeInteger(tabId) || tabId <= 0) { status.textContent = 'Укажите существующий tabId'; return; }
  try {
    const snap = await captureLocalTab(chrome, tabId, {
      approve: async ({ origin, title }) => window.confirm(
        'Создать локальный снимок вкладки ' + origin + '\\n' + title +
        '\\nПроверьте, что на экране нет токенов, паролей и личной информации. Снимок НЕ отправляется в сеть.'
      )
    });
    preview.src = snap.pngDataUrl;
    preview.hidden = false;
    status.textContent = 'Локальный снимок: ' + snap.provider + ', tabId=' + tabId +
      '. Передача другим AI отключена. Проверьте изображение и при необходимости очистите.';
  } catch (error) {
    status.textContent = 'Снимок не выполнен: ' + error.message +
      '. Вкладка должна быть активной в своём окне; Chrome также требует отдельное разрешение на захват экрана.';
  }
};
$('visualClear').onclick = () => {
  $('visualPreview').src = '';
  $('visualPreview').hidden = true;
  $('visualStatus').textContent = 'Локальный снимок удалён';
};

// ---------- старт ----------
fillAdapterSelect();
try {
  const savedKey = await loadBrowserKey(chrome);
  $('token').value = savedKey.value;
  $('keyStorageStatus').textContent = savedKey.persistent
    ? 'Ключ загружен. Проверяем подключение автоматически.'
    : savedKey.value ? 'Найден временный ключ. Нажмите «Подключить», чтобы сохранить его постоянно.'
    : 'Введите ключ один раз — он сохранится при подключении.';
  const { bridgeConnectionDesired, bridgeBackgroundMode } =
    await chrome.storage.local.get(['bridgeConnectionDesired','bridgeBackgroundMode']);
  if (bridgeBackgroundMode === true) {
    backgroundMode = true;
    $('backgroundMode').checked = true;
    const {bridgeMutationLabMode}=await chrome.storage.local.get('bridgeMutationLabMode');
    $('mutationLab').checked=bridgeMutationLabMode === true;
    $('actions').disabled = true;
    backgroundTimer = setInterval(updateBackgroundStatus, 2500);
    await updateBackgroundStatus();
    if (bridgeConnectionDesired === true && savedKey.value) {
      // The coordinator owns the connection, not the control window.
      void requestCoordinatorAck(
        ()=>chrome.runtime.sendMessage({target:'bridge-coordinator',type:'start-background'}),
        'BACKGROUND_START'
      ).catch(async error=>{
        try { await chrome.storage.local.set({bridgeConnectionDesired:false,bridgeMutationLabMode:false}); } catch {}
        setStatus('Автоподключение: ' + error.message);
      });
    }
  } else if (bridgeConnectionDesired === true && savedKey.value)
    void connectBridge({ automatic:true });
} catch (error) {
  $('keyStorageStatus').textContent = 'Безопасное хранилище недоступно: ' + error.message;
  $('token').value = '';
}
$('adapterJson').value = (await chrome.storage.local.get('adapters')).adapters || '{}';
await renderSites();
const visualCandidate = (await chrome.storage.session.get('visualCandidateTabId')).visualCandidateTabId;
if (Number.isSafeInteger(visualCandidate) && visualCandidate > 0)
  $('visualTabId').value = String(visualCandidate);
taskStatus('Ожидание подключения', 0);
log('Готово. Укажите ключ и нажмите «Подключить».');

