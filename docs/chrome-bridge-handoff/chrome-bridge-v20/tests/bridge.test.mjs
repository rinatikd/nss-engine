import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, loadConfig } from '../server/bridge.mjs';
import { extractVerdict, extractFiles, deepRender } from '../hub/lib.mjs';

async function setup(opts = {}) {
  const { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-test-')), cleanupStateDir = true, extensionId = 'a'.repeat(32), ...bridgeOpts } = opts;
  const config = { agentToken: 'a'.repeat(64), browserToken: 'b'.repeat(64), ...(extensionId ? { extensionId } : {}) };
  const server = createBridge(config, { timeout: 300, pollHold: 150, stateDir, ...bridgeOpts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body, token = config.agentToken, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers }, body: JSON.stringify(body) });
  const rpc = (name, args = {}) => post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.json());
  const poll = async () => (await (await post('/bridge/poll', {}, config.browserToken)).json()).command;
  return { server, base, stateDir, post, rpc, poll, close: () => new Promise((r) => server.close(r)).then(() => { if (cleanupStateDir) fs.rmSync(stateDir, { recursive: true, force: true }); }) };
}

test('auth, origin, host and tool validation', async () => {
  const s = await setup();
  try {
    assert.equal((await s.post('/mcp', {}, 'wrong')).status, 401);
    assert.equal((await s.post('/bridge/poll', {}, 'a'.repeat(64))).status, 401);
    assert.equal((await s.post('/mcp', {}, 'b'.repeat(64))).status, 401);
    assert.equal((await s.post('/mcp', [], 'a'.repeat(64), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.post('/mcp', [], 'a'.repeat(64), { Origin: 'chrome-extension://' + 'b'.repeat(32) })).status, 403);
    assert.equal((await s.post('/mcp', [], 'a'.repeat(64), { Origin: 'chrome-extension://' + 'a'.repeat(32) })).status, 200);
    assert.equal((await s.rpc('browser_read', { tabId: 1 })).result.isError, true); // СЂР°СЃС€РёСЂРµРЅРёРµ РЅРµ РїРѕРґРєР»СЋС‡РµРЅРѕ
    await s.poll();
    assert.equal(JSON.parse((await s.rpc('browser_status')).result.content[0].text).connected, true);
    for (const [n, a] of [['browser_open', { url: 'file:///secret' }], ['browser_read', { tabId: -1 }], ['browser_read', { tabId: 1, extra: 1 }], ['agent_bind', { name: 'Bad Name', tabId: 1 }], ['agent_send', { name: 'x', text: '' }], ['nope', {}]])
      assert.equal((await s.rpc(n, a)).result.isError, true, n);
    const init = await s.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }).then((r) => r.json());
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await s.post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }).then((r) => r.json());
    assert.equal(list.result.tools.length, 18);
    assert.equal((await s.post('/mcp', [])).status, 200);
  } finally { await s.close(); }
});

test('loadConfig pins only a validated explicit extension ID in temporary config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-extid-'));
  const old = process.env.CHROME_BRIDGE_EXTENSION_ID;
  try {
    process.env.CHROME_BRIDGE_EXTENSION_ID = 'c'.repeat(32);
    const config = loadConfig(dir);
    assert.equal(config.extensionId, 'c'.repeat(32));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).extensionId, 'c'.repeat(32));
    process.env.CHROME_BRIDGE_EXTENSION_ID = 'not-valid';
    assert.throws(() => createBridge({ ...config, extensionId: process.env.CHROME_BRIDGE_EXTENSION_ID }), /EXTENSION_ID_INVALID/);
  } finally {
    if (old === undefined) delete process.env.CHROME_BRIDGE_EXTENSION_ID; else process.env.CHROME_BRIDGE_EXTENSION_ID = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extension Origin fails closed when no exact extension ID is configured', async () => {
  const s = await setup({ extensionId: null });
  try {
    const response = await s.post('/mcp', [], 'a'.repeat(64), { Origin: 'chrome-extension://' + 'a'.repeat(32) });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /not pinned/);
  } finally { await s.close(); }
  assert.throws(() => createBridge({ agentToken: 'a', browserToken: 'b', extensionId: 'not-an-extension-id' }), /EXTENSION_ID_INVALID/);
});

test('long-poll dispatch, serial queue, errors, timeout', async () => {
  const s = await setup();
  try {
    const parked = s.poll(); // РїСЂРёРїР°СЂРєРѕРІР°Р»Рё long-poll РґРѕ РїРѕСЏРІР»РµРЅРёСЏ РєРѕРјР°РЅРґС‹
    await new Promise((r) => setTimeout(r, 30));
    const first = s.rpc('browser_tabs');
    const command = await parked;
    assert.equal(command.name, 'browser_tabs');
    const second = s.rpc('browser_read', { tabId: 7 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await s.poll(), null, 'РїРѕРєР° РїРµСЂРІР°СЏ РєРѕРјР°РЅРґР° РІС‹РїРѕР»РЅСЏРµС‚СЃСЏ, РІС‚РѕСЂР°СЏ РЅРµ РІС‹РґР°С‘С‚СЃСЏ');
    assert.equal((await s.post('/bridge/result', { id: 'unknown' }, 'b'.repeat(64))).status, 410);
    await s.post('/bridge/result', { id: command.id, result: [{ tabId: 7 }] }, 'b'.repeat(64));
    assert.deepEqual(JSON.parse((await first).result.content[0].text), [{ tabId: 7 }]);
    const c2 = await s.poll();
    await s.post('/bridge/result', { id: c2.id, error: 'User denied action' }, 'b'.repeat(64));
    assert.equal((await second).result.isError, true);
    const expired = await s.rpc('browser_tabs');
    assert.equal(expired.result.isError, true);
    assert.match(expired.result.content[0].text, /expired|disconnected/);
  } finally { await s.close(); }
});

test('agent_wait: Р¶РґС‘С‚ СЃС‚Р°Р±РёР»СЊРЅРѕРіРѕ РѕС‚РІРµС‚Р°, РѕС‚РґР°С‘С‚ РєСЌС€', async () => {
  const s = await setup({ timeout: 2000, settleMs: 100, pollMs: 20 });
  let stop = false, serve;
  try {
    await s.poll(); // Establish Chrome connectivity before racing bind against the poll loop.
    serve = (async () => {
      while (!stop) {
        const c = await s.poll().catch(() => null); if (!c) continue;
        const reply = { browser_tabs: [{ tabId: 5, mode: 'chat', url: 'u' }], agent_probe: { adapter: 'claude', verified: true }, agent_context: { verified: true, origin: 'https://claude.ai', conversationId: 'conversation-uuid-1234' }, agent_send: { baseline: 0, confirmed: true },
          agent_peek: { count: 1, text: c.args.n === undefined ? 'РіРѕС‚РѕРІРѕ' : '', generating: false, composerFound: true, url: 'u' } }[c.name];
        await s.post('/bridge/result', { id: c.id, result: reply }, 'b'.repeat(64));
      }
    })();
    await s.rpc('agent_bind', { name: 'gpt', tabId: 5 });
    assert.equal((await s.rpc('agent_wait', { name: 'gpt' })).result.isError, true); // РЅРёС‡РµРіРѕ РЅРµ РѕС‚РїСЂР°РІР»РµРЅРѕ
    const r = JSON.parse((await s.rpc('agent_ask', { name: 'gpt', text: 'РїСЂРёРІРµС‚', requestId: 'smoke-request-1', timeoutSec: 5 })).result.content[0].text);
    assert.equal(r.done, true); assert.equal(r.reply, 'РіРѕС‚РѕРІРѕ');
    assert.equal(r.deliveryStatus, 'UNKNOWN');
    assert.equal(r.replyAttribution, 'UNVERIFIED');
    assert.equal((await s.rpc('agent_send', { name: 'gpt', text: 'sk-abcdefghijklmnopqrstuvwxyz123456' })).result.isError, true);
  } finally { stop = true; await serve; await s.close(); }
});

test('agent_send requestId remains idempotent after Bridge restart and UNKNOWN is not resent', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-restart-'));
  let sends = 0;
  let stopping = false;
  let s;
  let worker;
  const runWorker = async (bridge) => {
    stopping = false;
    const loop = (async () => {
      while (!stopping) {
        const command = await bridge.poll().catch(() => null);
        if (!command) continue;
        if (command.name === 'agent_send') sends++;
        const result = {
          agent_probe: { adapter: 'claude', verified: true },
          agent_context: { verified: true, origin: 'https://claude.ai', conversationId: 'conversation-uuid-1234' },
          agent_send: { baseline: 0, confirmed: true },
          agent_peek: { count: sends, text: sends ? 'reply for independent smoke fixture' : '', generating: false, composerFound: true, url: 'https://chatgpt.com/' },
        }[command.name];
        await bridge.post('/bridge/result', { id: command.id, result }, 'b'.repeat(64));
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return async () => { stopping = true; await loop; };
  };
  try {
    s = await setup({ stateDir, cleanupStateDir: false, timeout: 1000, settleMs: 20, pollMs: 10 });
    worker = await runWorker(s);
    await s.rpc('agent_bind', { name: 'gpt', tabId: 5 });
    const first = JSON.parse((await s.rpc('agent_ask', { name: 'gpt', text: 'safe integration fixture', requestId: 'restart-safe-1', timeoutSec: 1 })).result.content[0].text);
    assert.equal(first.done, true);
    assert.equal(first.deliveryStatus, 'UNKNOWN');
    assert.equal(first.transportConfirmed, true);
    assert.equal(sends, 1);
    await worker(); worker = null;
    await s.close(); s = null;

    s = await setup({ stateDir, cleanupStateDir: false, timeout: 1000, settleMs: 20, pollMs: 10 });
    worker = await runWorker(s);
    const duplicate = JSON.parse((await s.rpc('agent_send', { name: 'gpt', text: 'safe integration fixture', requestId: 'restart-safe-1' })).result.content[0].text);
    assert.equal(duplicate.sent, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.deliveryStatus, 'UNKNOWN');
    assert.equal(sends, 1, 'same requestId after reload must not enqueue a second send');
    const otherRequest = await s.rpc('agent_send', { name: 'gpt', text: 'another prompt', requestId: 'restart-safe-2' });
    assert.equal(otherRequest.result.isError, true, 'a new request cannot replace an unresolved conversation');
    assert.match(otherRequest.result.content[0].text, /Previous request is still pending/);
    assert.equal(sends, 1);
    const conflict = await s.rpc('agent_send', { name: 'gpt', text: 'different text', requestId: 'restart-safe-1' });
    assert.equal(conflict.result.isError, true);
    assert.match(conflict.result.content[0].text, /SEND_ID_CONFLICT/);
    assert.equal(sends, 1);
  } finally {
    if (worker) await worker();
    if (s) await s.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('hub: verdict, files, templates', () => {
  assert.deepEqual(extractVerdict('С‚РµРєСЃС‚ {РЅРµ json} ```json\n{"score":7,"verdict":"revise","must_fix":["a"]}\n```').must_fix, ['a']);
  assert.equal(extractVerdict('РЅРµС‚ РІРµСЂРґРёРєС‚Р° {"x":1}'), null);
  assert.equal(extractVerdict('{"score":9,"verdict":"accept","summary":"СЃРєРѕР±РєРё } РІРЅСѓС‚СЂРё"}').verdict, 'accept');
  assert.deepEqual(extractFiles('=== FILE: a/b.txt ===\nhi\n=== END FILE ==='), [{ path: 'a/b.txt', content: 'hi\n' }]);
  assert.throws(() => extractFiles('=== FILE: ../x ===\nhi\n=== END FILE ==='), /Unsafe/);
  assert.throws(() => extractFiles('=== FILE: C:\\x ===\nhi\n=== END FILE ==='), /Unsafe/);
  assert.deepEqual(deepRender({ a: ['{{x}}'], b: 1 }, { x: 'q"\n' }), { a: ['q"\n'], b: 1 });
});

