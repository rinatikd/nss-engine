import { CONTROL_ORIGINS, DISCOVERY_ONLY_ORIGINS, providerForOrigin, CONTROL_ACTIONS, ControlGrants } from './permissions.js';
import { captureLocalTab } from './visual-snapshot.js';
import { loadBrowserKey, saveBrowserKey, forgetBrowserKey } from './browser-key-store.js';
import { DEFAULT_ADAPTERS, mergeAdapters } from './adapters.js';
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
function taskStatus(label, value, detail='') { $('taskState').textContent=label; $('taskProgress').value=value; $('taskTimes').textContent=timestamp() + (detail ? ' В· '+detail : ''); }
function refreshGrantLabels() {
  for (const row of $('sites').children) {
    const origin = row.dataset.origin;
    const ttl = row.querySelector('[data-ttl]');
    if (!origin || !ttl) continue;
    const expires = grants.grants.get(origin);
    const active = grants.status(origin, running && $('actions').checked).allowed;
    ttl.textContent = active ? 'Управление разрешено: ещё ' + Math.ceil((expires - Date.now()) / 60000) + ' мин' : 'Управление отключено';
    const connect = row.querySelector('[data-connect-control]');
    const disconnect = row.querySelector('[data-disconnect-control]');
    if (connect) connect.disabled = active || !running;
    if (disconnect) disconnect.disabled = !expires;
  }
  const global = $('controlGlobalState');
  if (global) global.textContent = !running ? 'Мост отключён; управление недоступно'
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

// ---------- С…СЂР°РЅРёР»РёС‰Рµ ----------
const getSites = async () => (await chrome.storage.local.get('sites')).sites || {};
const setSites = (sites) => chrome.storage.local.set({ sites });
async function getAdapters() {
  const { adapters } = await chrome.storage.local.get('adapters');
  try { return mergeAdapters(JSON.parse(adapters || '{}')); } catch { return mergeAdapters(); }
}

// ---------- Р¶СѓСЂРЅР°Р» ----------
const logLines = [];
function log(msg) {
  logLines.push(timestamp() + '  ' + msg);
  if (logLines.length > 80) logLines.shift();
  $('log').textContent = logLines.join('\n');
}
const setStatus = (s) => { $('status').textContent = s; };

// ---------- СЃР°Р№С‚С‹ ----------
async function renderSites() {
  const sites = await getSites();
  const perms = await chrome.permissions.getAll();
  const granted = new Set((perms.origins || []).map((o) => o.replace(/\/\*$/, '')));
  const ul = $('sites');
  ul.textContent = '';
  const entries = Object.entries(sites);
  if (!entries.length) { const li = document.createElement('li'); li.textContent = 'РЎР°Р№С‚С‹ РЅРµ РґРѕР±Р°РІР»РµРЅС‹.'; ul.append(li); }
  for (const [origin, s] of entries) {
    const li = document.createElement('li');
    li.dataset.origin = origin;
    const left = document.createElement('span');
    left.textContent = origin;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = s.mode === 'chat' ? 'РР-С‡Р°С‚ В· ' + s.adapter : 'С‡С‚РµРЅРёРµ';
    left.append(tag);
    if (!granted.has(origin)) { const w = document.createElement('span'); w.className = 'tag'; w.textContent = 'РЅРµС‚ СЂР°Р·СЂРµС€РµРЅРёСЏ Chrome'; left.append(w); }
    const rm = document.createElement('button');
    rm.className = 'secondary';
    rm.textContent = 'РЈР±СЂР°С‚СЊ';
    rm.onclick = async () => {
      const cur = await getSites();
      delete cur[origin];
      grants.grants.delete(origin);
      await setSites(cur);
      try { await chrome.permissions.remove({ origins: [origin + '/*'] }); } catch { /* СѓР¶Рµ СЃРЅСЏС‚Рѕ */ }
      await renderSites();
    };
    if (CONTROL_ORIGINS[origin]) {
      const connect = document.createElement('button');
      connect.dataset.connectControl = '';
      connect.textContent = 'Подключить управление';
      connect.onclick = (event) => {
        try {
          if (!running || !event.isTrusted) throw Error('Сначала подключите мост; требуется локальный клик');
          if (!$('actions').checked) throw Error('Включите глобальное разрешение действий в разделе «Безопасность»');
          const minutes = Number($('controlDuration').value);
          if (!window.confirm('Разрешить управление ' + origin + ' на ' + minutes + ' мин? Отправка запросов внешнему AI потребует подтверждения; не отправляйте секреты.')) return;
          grants.approve(origin, event.isTrusted, minutes);
          refreshGrantLabels();
          log('Control granted: ' + origin);
        } catch (e) { setStatus(e.message); refreshGrantLabels(); }
      };
      const disconnect = document.createElement('button');
      disconnect.dataset.disconnectControl = '';
      disconnect.className = 'secondary';
      disconnect.textContent = 'Отключить управление';
      disconnect.onclick = (event) => {
        if (!event.isTrusted) { setStatus('Требуется локальный клик'); return; }
        grants.revoke(origin);
        refreshGrantLabels();
        log('Control revoked: ' + origin);
      };
      const ttl = document.createElement('span');
      ttl.className = 'tag';
      ttl.dataset.ttl = '';
      li.append(ttl, connect, disconnect);
    }
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
$('adapter').onchange = syncOrigin;
function syncOrigin() {
  if ($('mode').value === 'chat' && !$('origin').value) $('origin').value = DEFAULT_ADAPTERS[$('adapter').value]?.origin || '';
}

$('grant').onclick = async () => {
  try {
    const u = new URL($('origin').value);
    if (u.protocol !== 'https:') throw Error('РќСѓР¶РµРЅ HTTPS-Р°РґСЂРµСЃ');
    if (LOCAL_HOSTS.includes(u.hostname)) throw Error('Р›РѕРєР°Р»СЊРЅС‹Рµ Р°РґСЂРµСЃР° Р·Р°РїСЂРµС‰РµРЅС‹');
    const ok = await chrome.permissions.request({ origins: [u.origin + '/*'] });
    if (!ok) throw Error('Chrome РЅРµ РІС‹РґР°Р» СЂР°Р·СЂРµС€РµРЅРёРµ');
    const sites = await getSites();
    const provider = providerForOrigin(u.origin);
    const mode = provider ? $('mode').value : 'read';
    sites[u.origin] = mode === 'chat' ? { mode, adapter: provider } : { mode };
    await setSites(sites);
    $('origin').value = '';
    await renderSites();
    log('РЎР°Р№С‚ РґРѕР±Р°РІР»РµРЅ: ' + u.origin + ' (' + mode + ')');
  } catch (e) { setStatus(e.message); }
};
$('revoke').onclick = async () => {
  stop();
  const p = await chrome.permissions.getAll();
  for (const o of p.origins || []) if (!o.includes('127.0.0.1')) await chrome.permissions.remove({ origins: [o] });
  await setSites({});
  await renderSites();
  log('Р’СЃРµ СЃР°Р№С‚С‹ РѕС‚РѕР·РІР°РЅС‹');
};
$('saveAdapters').onclick = async () => {
  try {
    const v = JSON.parse($('adapterJson').value || '{}');
    if (typeof v !== 'object' || Array.isArray(v) || v === null) throw Error('РќСѓР¶РµРЅ JSON-РѕР±СЉРµРєС‚');
    await chrome.storage.local.set({ adapters: JSON.stringify(v) });
    $('adapterMsg').textContent = 'РЎРѕС…СЂР°РЅРµРЅРѕ.';
  } catch (e) { $('adapterMsg').textContent = 'РћС€РёР±РєР°: ' + e.message; }
};

// ---------- РѕРґРѕР±СЂРµРЅРёСЏ ----------
function notify() {
  const n = approvals.size;
  document.title = n ? `(${n}) РџРѕРґС‚РІРµСЂРґРёС‚Рµ В· Chrome Bridge` : 'Chrome Bridge';
  if (n && audio) { try { const o = audio.createOscillator(); o.connect(audio.destination); o.frequency.value = 660; o.start(); o.stop(audio.currentTime + 0.15); } catch { /* Р·РІСѓРє РЅРµРѕР±СЏР·Р°С‚РµР»РµРЅ */ } }
  if (!n) { const box = $('approvals'); if (!box.children.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'РќРµС‚ РѕР¶РёРґР°СЋС‰РёС… Р·Р°РїСЂРѕСЃРѕРІ.'; box.append(p); } }
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
    const ok = document.createElement('button'); ok.textContent = 'Р Р°Р·СЂРµС€РёС‚СЊ';
    const no = document.createElement('button'); no.textContent = 'РћС‚РєР»РѕРЅРёС‚СЊ'; no.className = 'danger'; no.style.marginLeft = '8px';
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

// ---------- РІС‹РїРѕР»РЅРµРЅРёРµ РєРѕРјР°РЅРґ ----------
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
  const site = await siteOf(tab.url);
  const current = new URL(tab.url).origin;
  const previous = observedOrigins.get(tabId);
  if (previous && previous !== current) grants.grants.delete(previous);
  observedOrigins.set(tabId, current);
  if (!site) throw Error('Tab origin is not permitted');
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
      if (site) out.push({ tabId: t.id, title: t.title, url: t.url, mode: site.mode, adapter: site.adapter || null, active: t.active, windowId: t.windowId });
    }
    return out;
  }
  if (name === 'browser_open') {
    if (!(await siteOf(args.url))) throw Error('Origin not permitted: add this website in Chrome Bridge');
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
    if ($('confirmReads').checked) await askApproval('Р§С‚РµРЅРёРµ СЃС‚СЂР°РЅРёС†С‹', `${tab.url}\n${args.selector ? 'Р­Р»РµРјРµРЅС‚: ' + args.selector : 'Р’СЃСЏ СЃС‚СЂР°РЅРёС†Р°'}`, cmd.expires);
    const r = await inject(tab.id, site.origin, 'browser_read', args);
    return { ...r, text: redact(r.text), links: r.links.map((l) => ({ text: redact(l.text), url: redact(l.url) })) };
  }
  if (name === 'browser_click' || name === 'browser_fill') {
    if (!$('actions').checked) throw Error('Actions disabled in control tab');
    if (!running) throw Error('Stopped');
    const { tab, site } = await tabAndSite(args.tabId);
    grants.require(site.origin);
    const d = await inject(tab.id, site.origin, 'describe', { selector: args.selector });
    const lines = [`РЎС‚СЂР°РЅРёС†Р°: ${tab.url}`, `РЎРµР»РµРєС‚РѕСЂ: ${args.selector}`, `Р­Р»РµРјРµРЅС‚: <${d.tag}${d.type ? ' type=' + d.type : ''}> В«${d.text}В»`];
    if (d.href) lines.push('РЎСЃС‹Р»РєР°: ' + d.href);
    if (d.formAction) lines.push('РћС‚РїСЂР°РІР»СЏРµС‚ С„РѕСЂРјСѓ РЅР°: ' + d.formAction);
    if (name === 'browser_fill') lines.push('РўРµРєСЃС‚: ' + args.text.slice(0, 300) + (args.text.length > 300 ? 'вЂ¦' : ''));
    await askApproval(name === 'browser_click' ? 'РќР°Р¶Р°С‚РёРµ' : 'Р’РІРѕРґ С‚РµРєСЃС‚Р°', lines.join('\n'), cmd.expires);
    if (!running || Date.now() > cmd.expires) throw Error('Command stopped or expired');
    return inject(tab.id, site.origin, name, { ...args, expect: { tag: d.tag, text: d.text } });
  }

  // ---- Р°РіРµРЅС‚СЃРєРёРµ С‡Р°С‚С‹ ----
  if (name === 'agent_probe') {
    const { tab, site, adapter, adapterName } = await agentTab(args.tabId);
    const test = await inject(tab.id, site.origin, 'agent_selftest', { adapter });
    return { adapter: adapterName, verified: test.composer.visible === 1 && test.send.visible === 1 };

  }
  if (name === 'agent_context') {
    const { tab, site, adapter } = await agentTab(args.tabId);
    return inject(tab.id, site.origin, 'agent_context', { adapter });
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
    return result?.text ? { ...result, text: redact(result.text) } : result;
  }
  throw Error('Unknown command: ' + name);
}

// ---------- long-poll С†РёРєР» ----------
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
  log('в†’ ' + command.name);
  taskStatus('Р’С‹РїРѕР»РЅСЏРµС‚СЃСЏ: '+command.name, 35, 'Р—Р°РґР°РЅРёРµ РїСЂРёРЅСЏС‚Рѕ');
  try { result = await execute(command); } catch (e) { error = e.message; log('вњ— ' + command.name + ': ' + e.message); }
  taskStatus(error ? 'РћС€РёР±РєР°: '+command.name : 'Р—Р°РІРµСЂС€РµРЅРѕ: '+command.name, 100, error ? 'РЎРјРѕС‚СЂРёС‚Рµ Р¶СѓСЂРЅР°Р»' : 'Р РµР·СѓР»СЊС‚Р°С‚ РїРѕРґРіРѕС‚РѕРІР»РµРЅ');
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
      setStatus('РџРѕРґРєР»СЋС‡РµРЅРѕ В· РѕР¶РёРґР°РЅРёРµ РєРѕРјР°РЅРґ');
      if (!command && $('taskProgress').value !== 100) taskStatus('РћР¶РёРґР°РЅРёРµ РєРѕРјР°РЅРґ',0);
      if (command) await handle(command);
    } catch (e) {
      if (!running || gen !== generation) break;
      setStatus('РћС€РёР±РєР°: ' + e.message);
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
  setStatus('РћС‚РєР»СЋС‡РµРЅРѕ');
  taskStatus('РћС‚РєР»СЋС‡РµРЅРѕ', 0);
}
$('actions').addEventListener('change', (event) => {
  if (!event.isTrusted) { $('actions').checked = false; }
  if (!$('actions').checked) grants.grants.clear();
  refreshGrantLabels();
});
$('stop').onclick = stop;
$('connect').onclick = async () => {
  if (running) return;
  try {
    await saveBrowserKey(chrome, $('token').value);
    $('keyStorageStatus').textContent = 'Ключ сохранён в локальном хранилище расширения (только доверенные контексты).';
  } catch (error) {
    setStatus('Ключ не сохранён: ' + error.message);
    return; // Do not connect without secure credential storage.
  }
  try { audio = new AudioContext(); } catch { audio = null; }
  // РЈРґРµСЂР¶Р°РЅРёРµ Web Lock РїРѕРјРѕРіР°РµС‚ Chrome РЅРµ В«Р·Р°РјРѕСЂР°Р¶РёРІР°С‚СЊВ» РІРєР»Р°РґРєСѓ РІ С„РѕРЅРµ.
  navigator.locks.request('chrome-bridge-control', () => new Promise((r) => { releaseLock = r; }));
  running = true;
  refreshGrantLabels();
  pollAbort = new AbortController();
  loop(generation);
};
$('forgetKey').onclick = async (event) => {
  if (!event.isTrusted) return;
  if (!window.confirm('Удалить сохранённый ключ браузера из Chrome Bridge и отключить мост?')) return;
  try {
    stop();
    await forgetBrowserKey(chrome);
    $('token').value = '';
    $('keyStorageStatus').textContent = 'Сохранённый ключ удалён. Для подключения потребуется ввести его заново.';
  } catch (error) {
    setStatus('Не удалось удалить ключ: ' + error.message);
  }
};
window.addEventListener('beforeunload', stop);

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

// ---------- СЃС‚Р°СЂС‚ ----------
fillAdapterSelect();
try {
  const savedKey = await loadBrowserKey(chrome);
  $('token').value = savedKey.value;
  $('keyStorageStatus').textContent = savedKey.persistent
    ? 'Ключ загружен из постоянного хранилища расширения.'
    : savedKey.value ? 'Найден временный ключ. Нажмите «Подключить», чтобы сохранить его постоянно.'
    : 'Введите ключ один раз — он сохранится при подключении.';
} catch (error) {
  $('keyStorageStatus').textContent = 'Безопасное хранилище недоступно: ' + error.message;
  $('token').value = '';
}
$('adapterJson').value = (await chrome.storage.local.get('adapters')).adapters || '{}';
await renderSites();
const visualCandidate = (await chrome.storage.session.get('visualCandidateTabId')).visualCandidateTabId;
if (Number.isSafeInteger(visualCandidate) && visualCandidate > 0)
  $('visualTabId').value = String(visualCandidate);
taskStatus('РћР¶РёРґР°РЅРёРµ РїРѕРґРєР»СЋС‡РµРЅРёСЏ', 0);
log('Р“РѕС‚РѕРІРѕ. РЈРєР°Р¶РёС‚Рµ РєР»СЋС‡ Рё РЅР°Р¶РјРёС‚Рµ В«РџРѕРґРєР»СЋС‡РёС‚СЊВ».');

