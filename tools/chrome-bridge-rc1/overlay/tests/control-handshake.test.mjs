import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createBridge } from '../server/bridge.mjs';
import * as permissions from '../extension/permissions.js';

async function bridgeFixture(t) {
  const config = { agentToken: 'a'.repeat(64), browserToken: 'b'.repeat(64) };
  const server = createBridge(config, { pollHold: 2000, timeout: 1000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, token = config.browserToken, signal) => fetch(base + route, { method: 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { config, post };
}

test('authenticated hello returns epoch before the normal poll hold expires', async t => {
  const { post } = await bridgeFixture(t);
  const response = await post('/bridge/poll', { hello: true }, undefined, AbortSignal.timeout(1000));
  assert.equal(response.status, 200);
  const hello = await response.json();
  assert.equal(hello.command, null);
  assert.match(hello.epoch, /^[a-f0-9-]{36}$/);
});

test('hello cannot bypass browser authentication and legacy polls still wait', async t => {
  const { post } = await bridgeFixture(t);
  assert.equal((await post('/bridge/poll', { hello: true }, 'invalid')).status, 401);
  await assert.rejects(post('/bridge/poll', {}, undefined, AbortSignal.timeout(100)), /timeout|abort/i);
});

test('hello does not dispatch a queued browser command before the client initializes its epoch', async t => {
  const { post, config } = await bridgeFixture(t);
  await post('/bridge/poll', { hello: true });
  const call = post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } }, config.agentToken);
  call.catch(() => {}); // Cleanup may close this request if an assertion fails.
  await new Promise(resolve => setTimeout(resolve, 20));
  const hello = await (await post('/bridge/poll', { hello: true })).json();
  assert.equal(hello.command, null);
  const { command, epoch } = await (await post('/bridge/poll', {})).json();
  assert.equal(command.name, 'browser_tabs');
  assert.equal(epoch, hello.epoch);
  await post('/bridge/result', { id: command.id, result: [] });
  assert.equal((await call).status, 200);
});

function controlHarness() {
  const source = fs.readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').split('// ---------- старт ----------')[0];
  const grant = {}, ttl = {};
  const row = { dataset: { origin: 'https://claude.ai' }, querySelector: selector => selector === '[data-ttl]' ? ttl : selector === '[data-control-grant]' ? grant : null };
  const elements = new Map([['sites', { children: [row] }]]);
  const bodies = [], retryTimers = [];
  let helloResolve, pollReject;
  const first = new Promise(resolve => { helloResolve = resolve; });
  const second = new Promise((_resolve, reject) => { pollReject = reject; });
  const context = vm.createContext({ ...permissions, console, URL, Date, Intl, Map, Set, Promise,
    AbortSignal, AbortController,
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, { value: 0 }); return elements.get(id); } },
    window: { addEventListener() {} },
    setInterval() {}, setTimeout: (fn, ms) => { assert.equal(ms, 2000); retryTimers.push(fn); },
    chrome: { runtime: { onMessage: { addListener() {} } }, tabs: { onUpdated: { addListener() {} } } },
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return bodies.length === 1 ? first : second; },
  });
  vm.runInContext(source, context);
  return { grant, ttl, bodies, retryTimers, helloResolve, pollReject, run: code => vm.runInContext(code, context) };
}

test('Grant stays disabled until hello and disconnect clears grants, nonces and labels', async () => {
  const h = controlHarness();
  h.run('running = true; pollAbort = new AbortController(); refreshGrantLabels()');
  assert.throws(() => h.run("grants.approve('https://claude.ai', true)"), /Local approval/);
  assert.equal(h.grant.disabled, true);
  const loop = h.run('loop(generation)');
  try {
    assert.deepEqual(h.bodies[0], { hello: true });
    h.helloResolve({ ok: true, json: async () => ({ command: null, epoch: 'test-epoch' }) });
    await new Promise(setImmediate);
    assert.equal(h.grant.disabled, false);
    assert.equal(h.run('grants.epoch'), 'test-epoch');
    h.run("grants.approve('https://claude.ai', true); injectedControls.set('nonce', {}); refreshGrantLabels()");
    assert.match(h.ttl.textContent, /До окончания:/);
    assert.deepEqual(h.bodies[1], {});
    h.pollReject(Error('synthetic transport failure'));
    await new Promise(setImmediate);
    assert.equal(h.run('grants.epoch'), null);
    assert.equal(h.run('injectedControls.size'), 0);
    assert.equal(h.grant.disabled, true);
    assert.equal(h.ttl.textContent, 'Нет активного разрешения');
  } finally {
    h.run('stop()');
    h.helloResolve({ ok: true, json: async () => ({ command: null, epoch: 'test-epoch' }) });
    h.pollReject(Error('finished'));
    await new Promise(setImmediate);
    for (const timer of h.retryTimers) timer();
    await loop;
  }
});
