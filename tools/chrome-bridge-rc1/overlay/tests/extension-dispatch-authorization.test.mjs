import test from 'node:test';
import assert from 'node:assert/strict';
import { pageAction } from '../extension/page.js';

async function fixture(run, decisions = [true, true]) {
  const saved = new Map();
  const replace = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  let clicks = 0, checks = 0, value = '';
  class Textarea { get value() { return value; } set value(v) { value = v; } getClientRects() { return [1]; } focus() {} dispatchEvent() {} }
  const composer = new Textarea();
  const button = { disabled: false, getClientRects: () => [1], getAttribute: () => null, click: () => { clicks++; } };
  replace('HTMLTextAreaElement', Textarea);
  replace('HTMLInputElement', class {});
  replace('location', { origin: 'https://claude.ai', pathname: '/chat/fixture-12345678' });
  replace('document', { querySelectorAll: (selector) => selector === '#composer' ? [composer] : selector === '#send' ? [button] : [] });
  replace('chrome', { runtime: { sendMessage: async () => ({ allowed: decisions[checks++] ?? false }) } });
  replace('setTimeout', (fn) => { queueMicrotask(fn); return 0; });
  const args = { controlExpires: Date.now() + 60_000, controlAuthorization: 'local-command-nonce', expectedOrigin: location.origin, expectedConversationId: 'fixture-12345678', text: 'fixture prompt', adapter: { composer: '#composer', send: '#send', stop: '#stop', reply: '#reply' } };
  try { await run({ args, clicks: () => clicks, checks: () => checks, value: () => value }); }
  finally { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
}

test('a control revoked while a send waits cannot dispatch', async () => {
  await fixture(async ({ args, clicks, checks }) => {
    const result = await pageAction('agent_send', args, 'https://claude.ai');
    assert.equal(clicks(), 0, 'revoked command must never click Send');
    assert.match(result.error, /Control denied/);
    assert.equal(checks(), 2);
  }, [true, false]);
});

test('missing command authorization fails closed before editing the draft', async () => {
  await fixture(async ({ args, clicks, value }) => {
    delete args.controlAuthorization;
    const result = await pageAction('agent_send', args, 'https://claude.ai');
    assert.equal(value(), '');
    assert.equal(clicks(), 0);
    assert.match(result.error, /Control denied/);
  });
});

test('a live command can dispatch once; a disconnected control channel fails closed', async () => {
  await fixture(async ({ args, clicks, checks }) => {
    await pageAction('agent_send', args, 'https://claude.ai');
    assert.equal(clicks(), 1);
    assert.equal(checks(), 2);
  });
  await fixture(async ({ args, clicks, value }) => {
    chrome.runtime.sendMessage = async () => { throw Error('Control tab closed'); };
    assert.match((await pageAction('agent_send', args, 'https://claude.ai')).error, /Control tab closed/);
    assert.equal(clicks(), 0);
    assert.equal(value(), '');
  });
});

// Load the actual control listener with inert UI/Chrome APIs; never connect to a bridge.
async function controlHarness() {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const permissions = await import('../extension/permissions.js');
  const source = (await readFile(new URL('../extension/control.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').split('// ---------- старт ----------')[0];
  const elements = new Map();
  const sites = { 'https://claude.ai': { mode: 'chat', adapter: 'claude' } };
  let listener, chromePermission = true;
  const context = vm.createContext({ ...permissions, console, URL, Date, Intl, Map, Set, Promise,
    document: { getElementById: (id) => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    window: { addEventListener() {} }, setInterval() {},
    chrome: { runtime: { id: 'extension-id', onMessage: { addListener: (fn) => { listener = fn; } } },
      tabs: { onUpdated: { addListener() {} } }, storage: { local: { get: async () => ({ sites }) } },
      permissions: { contains: async () => chromePermission } },
  });
  vm.runInContext(source, context);
  const setup = () => vm.runInContext(`running = true; grants.reset('epoch'); grants.approve('https://claude.ai', true); injectedControls.set('nonce', { tabId: 7, origin: 'https://claude.ai', expires: Date.now()+60000 });`, context);
  setup();
  const sender = { id: 'extension-id', tab: { id: 7 }, origin: 'https://claude.ai', url: 'https://claude.ai/chat/fixture-12345678' };
  const request = (overrides = {}, authorization = 'nonce') => new Promise((resolve) => listener({ type: 'chrome-bridge-control-check', authorization }, { ...sender, ...overrides }, (result) => resolve(result.allowed)));
  return { request, setup, run: (s) => vm.runInContext(s, context), revokeChrome: () => { chromePermission = false; } };
}

test('control listener binds authorization to extension, tab, origin, expiry and live grant', async () => {
  const h = await controlHarness();
  assert.equal(await h.request(), true);
  for (const sender of [{ id: 'other-extension' }, { tab: { id: 8 } }, { origin: 'https://gemini.google.com' }, { url: 'https://example.com/' }]) {
    assert.equal(await h.request(sender), false);
  }
  assert.equal(await h.request({}, 'other-nonce'), false);
  h.run('running = false');
  assert.equal(await h.request(), false);
  h.setup(); h.run('grants.reset()');
  assert.equal(await h.request(), false);
  h.setup(); h.run("injectedControls.get('nonce').expires = 0");
  assert.equal(await h.request(), false);
  h.setup(); h.run('stop()');
  assert.equal(await h.request(), false);
  h.setup(); h.revokeChrome();
  assert.equal(await h.request(), false);
});
