import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as permissions from '../extension/permissions.js';
import { pageAction } from '../extension/page.js';

async function pageFixture(change) {
  const saved = new Map();
  const replace = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  let value = '', clicks = 0, checks = 0, now = Date.now();
  class Textarea { get value() { return value; } set value(v) { value = v; } getClientRects() { return [1]; } focus() {} dispatchEvent() {} }
  const composer = new Textarea();
  const button = { disabled: false, getClientRects: () => [1], getAttribute: () => null, click: () => { clicks++; } };
  let send = [button];
  replace('HTMLTextAreaElement', Textarea);
  replace('HTMLInputElement', class {});
  replace('location', { origin: 'https://claude.ai', pathname: '/chat/fixture-12345678' });
  replace('document', { querySelectorAll: selector => selector === '#composer' ? [composer] : selector === '#send' ? send : selector === '#stop' && clicks ? [button] : [] });
  replace('chrome', { runtime: { sendMessage: async () => {
    if (++checks === 2) await change?.({ composer, button, setSend: v => { send = v; }, expire: () => { now += 120_000; } });
    return { allowed: true };
  } } });
  replace('Date', class extends Date { static now() { return now; } });
  replace('setTimeout', fn => { queueMicrotask(fn); return 0; });
  try {
    const result = await pageAction('agent_send', { controlExpires: now + 60_000, commandExpires: now + 60_000,
      controlAuthorization: 'nonce', expectedOrigin: location.origin, expectedConversationId: 'fixture-12345678',
      text: 'fixture prompt', adapter: { composer: '#composer', send: '#send', stop: '#stop', reply: '#reply' } }, location.origin);
    return { result, clicks, value, checks };
  } finally { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
}

test('send rechecks the draft after awaited dispatch authorization', async () => {
  const observed = await pageFixture(async ({ composer }) => { composer.value = 'user changed draft'; });
  assert.equal(observed.clicks, 0);
  assert.match(observed.result.error, /draft|Prompt|Composer/i);
});

test('send rechecks the selected button after awaited dispatch authorization', async () => {
  for (const change of [({ setSend }) => setSend([]), ({ button }) => { button.disabled = true; },
    ({ setSend, button }) => setSend([button, { ...button }])]) {
    const observed = await pageFixture(change);
    assert.equal(observed.clicks, 0);
    assert.match(observed.result.error, /send button|selector/i);
  }
});

test('an authorization response received after expiry cannot dispatch', async () => {
  const observed = await pageFixture(({ expire }) => expire());
  assert.equal(observed.clicks, 0);
  assert.match(observed.result.error, /expired|Control denied/i);
});

function controlHarness() {
  const source = fs.readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').split('// ---------- старт ----------')[0];
  const elements = new Map([['sites', { children: [] }]]);
  let permissionResolve, listener, updated, injectedResolve;
  let permission = async () => true;
  const injections = [];
  const context = vm.createContext({ ...permissions, console, URL, Date, Intl, Map, Set, Promise,
    AbortController, crypto: { randomUUID: () => 'nonce' },
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    window: { addEventListener() {} }, setInterval() {},
    chrome: { runtime: { id: 'extension-id', onMessage: { addListener: fn => { listener = fn; } } },
      tabs: { get: async () => ({ id: 7, url: 'https://claude.ai/chat/fixture-12345678' }), onUpdated: { addListener: fn => { updated = fn; } } },
      scripting: { executeScript: async options => { injections.push(options); return new Promise(resolve => { injectedResolve = resolve; }); } },
      storage: { local: { get: async () => ({ sites: { 'https://claude.ai': { mode: 'chat', adapter: 'claude' } } }) } },
      permissions: { contains: () => permission() } },
    pageAction,
    mergeAdapters: () => ({ claude: { origin: 'https://claude.ai' } }), findSecret: () => null,
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const setup = () => run("running = true; grants.reset('epoch'); grants.approve('https://claude.ai', true)");
  setup();
  return { run, setup, injections, updated,
    deferPermission() { permission = () => new Promise(resolve => { permissionResolve = resolve; }); },
    resolvePermission() { permissionResolve(true); },
    finishInjection(result = { sent: true }) { injectedResolve([{ result }]); },
    request: () => new Promise(resolve => listener({ type: 'chrome-bridge-control-check', authorization: 'nonce' },
      { id: 'extension-id', tab: { id: 7 }, origin: 'https://claude.ai', url: 'https://claude.ai/chat/fixture-12345678' }, response => resolve(response.allowed))),
  };
}

const flush = () => new Promise(setImmediate);

test('a command awaiting host permission cannot resume into a later connection or epoch', async () => {
  for (const transition of [h => { h.run('stop()'); h.setup(); },
    h => h.run("grants.reset('new-epoch'); grants.approve('https://claude.ai', true)")]) {
    const h = controlHarness();
    h.deferPermission();
    const command = h.run("execute({name:'agent_send', args:{tabId:7,text:'hello'}, expires:Date.now()+60000})");
    const observed = command.then(value => ({ value }), error => ({ error }));
    await flush();
    transition(h);
    h.resolvePermission();
    await flush();
    if (h.injections.length) h.finishInjection();
    const result = await observed;
    assert.equal(h.injections.length, 0);
    assert.match(result.error?.message || '', /stopped|expired|connection/i);
  }
});

test('same-origin navigation and reload invalidate an in-flight control nonce', async () => {
  for (const change of [{ url: 'https://claude.ai/chat/another-12345678' }, { status: 'loading' }]) {
    const h = controlHarness();
    const injection = h.run("inject(7,'https://claude.ai','agent_send',{})");
    await flush();
    assert.equal(await h.request(), true);
    h.updated(7, change);
    assert.equal(await h.request(), false);
    h.finishInjection(); await injection;
  }
});

test('authorization awaiting host permission cannot survive an epoch change and re-grant', async () => {
  const h = controlHarness();
  const injection = h.run("inject(7,'https://claude.ai','agent_send',{})");
  h.deferPermission();
  const request = h.request();
  await flush();
  h.run("grants.reset('new-epoch'); grants.approve('https://claude.ai', true)");
  h.resolvePermission();
  assert.equal(await request, false);
  h.finishInjection(); await injection;
});

test('navigation during click approval cannot authorize an action on the replacement page', async () => {
  const h = controlHarness();
  h.run("$('actions').checked = true; let approveAction; askApproval = () => new Promise(resolve => { approveAction = resolve; })");
  const command = h.run("execute({name:'browser_click', args:{tabId:7,selector:'#send'}, expires:Date.now()+60000})");
  const observed = command.then(value => ({ value }), error => ({ error }));
  await flush();
  h.finishInjection({ tag: 'button', text: 'Send' });
  await flush();
  h.updated(7, { url: 'https://claude.ai/chat/another-12345678' });
  h.run('approveAction(true)');
  await flush();
  if (h.injections.length > 1) h.finishInjection({ clicked: true });
  const result = await observed;
  assert.equal(h.injections.length, 1, 'description only: never inject the approved click into a replacement page');
  assert.match(result.error?.message || '', /navigat|changed/i);
});

test('an uninterrupted command still receives a nonce and can complete', async () => {
  const h = controlHarness();
  const command = h.run("execute({name:'agent_send', args:{tabId:7,text:'hello'}, expires:Date.now()+60000})");
  await flush();
  assert.equal(h.injections.length, 1);
  assert.equal(h.injections[0].args[1].controlAuthorization, 'nonce');
  assert.equal(await h.request(), true);
  h.finishInjection();
  assert.equal((await command).sent, true);
  assert.equal(await h.request(), false, 'a completed command nonce is removed');
});

async function rawActionFixture(action, navigate) {
  let clicks = 0, value = '';
  class Textarea {
    get value() { return value; } set value(v) { value = v; }
    getClientRects() { return [1]; } dispatchEvent() {}
  }
  const element = action === 'browser_fill' ? new Textarea() : {
    getClientRects: () => [1], closest: () => null, click() { clicks++; },
  };
  const location = { origin: 'https://claude.ai', pathname: '/chat/fixture-12345678', href: 'https://claude.ai/chat/fixture-12345678' };
  const context = vm.createContext({ Date, Promise, HTMLTextAreaElement: Textarea, HTMLInputElement: class {}, Event: class {},
    location, document: { querySelectorAll: () => [element] },
    chrome: { runtime: { sendMessage: async () => {
      if (navigate) { location.pathname = '/chat/another-12345678'; location.href = location.origin + location.pathname; }
      return { allowed: true };
    } } },
  });
  const run = vm.runInContext('(' + pageAction.toString() + ')', context);
  const result = await run(action, { selector: '#target', text: 'fixture text', controlExpires: Date.now() + 60_000,
    controlAuthorization: 'nonce', expectedUrl: location.href }, location.origin);
  return { result, clicks, value };
}

for (const action of ['browser_click', 'browser_fill']) {
  test(action + ' rejects same-origin navigation during awaited authorization', async () => {
    const observed = await rawActionFixture(action, true);
    assert.equal(observed.clicks, 0);
    assert.equal(observed.value, '');
    assert.match(observed.result.error, /navigat|changed/i);
  });
}

test('raw click and fill still work when the approved URL stays unchanged', async () => {
  assert.equal((await rawActionFixture('browser_click', false)).clicks, 1);
  assert.equal((await rawActionFixture('browser_fill', false)).value, 'fixture text');
});

test('raw control dispatch uses the inspected tab URL rather than caller-supplied URL', async () => {
  const h = controlHarness();
  h.run("$('actions').checked = true; askApproval = async () => true");
  const command = h.run("execute({name:'browser_click', args:{tabId:7,selector:'#send',expectedUrl:'https://claude.ai/chat/forged-12345678'}, expires:Date.now()+60000})");
  await flush();
  h.finishInjection({ tag: 'button', text: 'Send' });
  await flush();
  assert.equal(h.injections[1].args[1].expectedUrl, 'https://claude.ai/chat/fixture-12345678');
  h.finishInjection({ clicked: true });
  assert.equal((await command).clicked, true);
});
