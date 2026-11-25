import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBridge, loadConfig, resolveSessionScope, BUILD_INFO, VERSION } from '../server/bridge.mjs';
import { tools as registeredTools } from '../server/tools.mjs';
import { validateArgs } from '../server/schema.mjs';
import { createChromeBridgeProviderTransport } from '../consilium-control-room/consilium/chrome-bridge-provider-adapter.mjs';

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
    assert.deepEqual(list.result.tools, registeredTools.map(({ kind, ...tool }) => tool));
    assert.ok(list.result.tools.some(({ name }) => name === 'agent_send'));
    for (const name of [
      'session_request', 'session_authorize', 'session_revoke', 'session_status',
      'provider_prepare', 'provider_commit', 'provider_status', 'provider_reply_wait', 'provider_stop',
      'provider_revoke', 'provider_events'
    ])
      assert.ok(list.result.tools.some((tool) => tool.name === name), `missing ${name}`);
    assert.equal((await s.post('/mcp', [])).status, 200);
  } finally { await s.close(); }
});

test('MCP schema validator accepts only bounded arrays of allowed session providers', () => {
  const tool = registeredTools.find(({ name }) => name === 'session_request');
  assert.ok(tool);
  assert.doesNotThrow(() => validateArgs(tool, { durationMinutes: 60, providers: ['claude', 'grok'] }));
  assert.throws(() => validateArgs(tool, { durationMinutes: 60 }), /Missing argument: providers/);
  assert.throws(() => validateArgs(tool, { durationMinutes: 60, providers: [] }), /Invalid argument: providers/);
  assert.throws(() => validateArgs(tool, { durationMinutes: 60, providers: ['claude', 'unknown'] }), /Invalid argument: providers\[1\]/);
  assert.throws(() => validateArgs(tool, { durationMinutes: 60, providers: ['claude', 'grok', 'deepseek', 'gemini', 'qwen', 'kimi', 'extra'] }), /Invalid argument: providers/);
});

test('session scope grants only selected providers and fails closed for missing or mismatched tabs', () => {
  const claude = { tabId: 11, mode: 'chat', adapter: 'claude', url: 'https://claude.ai/chat/conversation_01' };
  const grok = { tabId: 12, mode: 'chat', adapter: 'grok', url: 'https://grok.com/c/conversation_02' };
  const gemini = { tabId: 13, mode: 'chat', adapter: 'gemini', url: 'https://gemini.google.com/app/conversation_03' };
  const ready = resolveSessionScope(['claude', 'grok'], [claude, grok, gemini]);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.providers, ['claude', 'grok']);
  assert.deepEqual(ready.origins, ['https://claude.ai', 'https://grok.com']);
  assert.deepEqual(ready.missingProviders, []);

  const missing = resolveSessionScope(['claude', 'grok'], [claude, gemini]);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missingProviders, ['grok']);

  const mismatched = resolveSessionScope(['claude', 'grok'], [
    claude, { ...grok, adapter: 'claude' }
  ]);
  assert.deepEqual(mismatched.missingProviders, ['grok']);
  assert.throws(() => resolveSessionScope(['grok'], [grok]), /SESSION_CLAUDE_REQUIRED/);
  assert.throws(() => resolveSessionScope(['claude', 'claude'], [claude]), /SESSION_PROVIDERS_DUPLICATE/);
  assert.throws(() => resolveSessionScope(['claude', 'unknown'], [claude]), /SESSION_PROVIDER_DENIED/);
});


test('session_request rejects a Claude-less session before contacting the browser', async () => {
  const s = await setup();
  try {
    const response = await s.rpc('session_request', { durationMinutes: 60, providers: ['grok'] });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /SESSION_CLAUDE_REQUIRED/);
    const status = JSON.parse((await s.rpc('browser_status')).result.content[0].text);
    assert.equal(status.queued, 0);
  } finally { await s.close(); }
});


test('session challenge authorizes only selected providers and round-trips status and revoke', async () => {
  const s = await setup();
  const tabs = [
    { tabId: 11, mode: 'chat', adapter: 'claude', url: 'https://claude.ai/chat/conversation_01' },
    { tabId: 12, mode: 'chat', adapter: 'grok', url: 'https://grok.com/c/conversation_02' },
    { tabId: 13, mode: 'chat', adapter: 'gemini', url: 'https://gemini.google.com/app/conversation_03' }
  ];
  const browserKey = 'b'.repeat(64);
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  const ack = async (command, result) => {
    const response = await s.post('/bridge/result', {id:command.id,result}, browserKey);
    assert.equal(response.status, 200);
  };
  try {
    // Challenge request performs a real server queue round-trip for browser_tabs.
    const challengePoll = s.poll();
    await pause();
    const challengeRequest = s.rpc('session_request', {
      durationMinutes: 60, providers: ['claude', 'grok']
    });
    const discovery = await challengePoll;
    assert.equal(discovery.name, 'browser_tabs');
    await ack(discovery, tabs);
    const challengeResponse = await challengeRequest;
    assert.notEqual(challengeResponse.result.isError, true);
    const challenge = JSON.parse(challengeResponse.result.content[0].text);
    assert.equal(challenge.ready, true);
    assert.equal(challenge.approvalRequired, true);
    assert.equal(challenge.changedNothing, true);
    assert.deepEqual(challenge.providers, ['claude', 'grok']);
    assert.deepEqual(challenge.origins, ['https://claude.ai', 'https://grok.com']);
    assert.deepEqual(challenge.capabilities, ['agent_send', 'provider_prepare', 'provider_commit']);

    // Authorize rechecks the provider tab set before dispatching session_authorize.
    const recheckPoll = s.poll();
    await pause();
    const authorizeRequest = s.rpc('session_authorize', {challengeId:challenge.challengeId});
    const recheck = await recheckPoll;
    assert.equal(recheck.name, 'browser_tabs');
    await ack(recheck, tabs);
    const authorizePoll = s.poll();
    const authorizeCommand = await authorizePoll;
    assert.equal(authorizeCommand.name, 'session_authorize');
    assert.equal(authorizeCommand.args.sessionId, challenge.sessionId);
    assert.equal(authorizeCommand.args.durationMinutes, 60);
    assert.deepEqual(authorizeCommand.args.origins, challenge.origins);
    await ack(authorizeCommand, {
      active:true,
      sessionId:challenge.sessionId,
      bridgeEpoch:challenge.bridgeEpoch,
      origins:challenge.origins,
      capabilities:challenge.capabilities
    });
    const authorized = JSON.parse((await authorizeRequest).result.content[0].text);
    assert.equal(authorized.active, true);
    assert.equal(authorized.challengeId, challenge.challengeId);

    const statusPoll = s.poll();
    await pause();
    const statusRequest = s.rpc('session_status');
    const statusCommand = await statusPoll;
    assert.equal(statusCommand.name, 'session_status');
    await ack(statusCommand, {
      active:true,
      sessionId:challenge.sessionId,
      bridgeEpoch:challenge.bridgeEpoch,
      origins:challenge.origins,
      capabilities:challenge.capabilities
    });
    const status = JSON.parse((await statusRequest).result.content[0].text);
    assert.equal(status.active, true);
    assert.deepEqual(status.origins, challenge.origins);

    const revokePoll = s.poll();
    await pause();
    const revokeRequest = s.rpc('session_revoke');
    const revokeCommand = await revokePoll;
    assert.equal(revokeCommand.name, 'session_revoke');
    await ack(revokeCommand, {revoked:true});
    const revoked = JSON.parse((await revokeRequest).result.content[0].text);
    assert.equal(revoked.revoked, true);
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

test('dispatched timeout holds the single-writer lane until a late ACK', async () => {
  const s = await setup({ timeout: 120, pollHold: 50 });
  try {
    const firstPoll = s.poll();
    await new Promise(resolve => setTimeout(resolve, 10));
    const firstPromise = s.rpc('browser_tabs');
    const firstCommand = await firstPoll;
    assert.equal(firstCommand.name, 'browser_tabs');
    const first = await firstPromise;
    assert.equal(first.result.isError, true);
    assert.match(first.result.content[0].text, /expired after dispatch/);

    const secondPromise = s.rpc('browser_read', { tabId: 7 });
    const secondPoll = s.poll();
    await new Promise(resolve => setTimeout(resolve, 10));
    const lateAck = await s.post('/bridge/result', {
      id: firstCommand.id, result: [{ tabId: 7 }]
    }, 'b'.repeat(64));
    assert.equal(lateAck.status, 200);
    assert.deepEqual(await lateAck.json(), { ok: true, late: true });

    const secondCommand = await secondPoll;
    assert.equal(secondCommand.name, 'browser_read');
    await s.post('/bridge/result', {
      id: secondCommand.id, result: { text: 'read-only result', links: [] }
    }, 'b'.repeat(64));
    const second = await secondPromise;
    assert.notEqual(second.result.isError, true);
    assert.deepEqual(JSON.parse(second.result.content[0].text), { text: 'read-only result', links: [] });
  } finally { await s.close(); }
});


test('Chrome Bridge ProviderTransport adapter completes a synthetic prepare/commit/fence cycle', { timeout: 15000 }, async () => {
  const s = await setup({ timeout: 3000, pollHold: 40 });
  let running = true;
  let responderError = null;
  const responder = (async () => {
    while (running) {
      let command;
      try { command = await s.poll(); }
      catch (error) { if (running) responderError = error; break; }
      if (!command) continue;
      let result;
      if (command.name === 'agent_probe') result = { adapter: 'claude', verified: true };
      else if (command.name === 'agent_context') result = {
        verified: true, origin: 'https://claude.ai', conversationId: 'conversation_001'
      };
      else if (command.name === 'provider_prepare') result = {
        prepared: true, requestId: command.args.requestId, preparedId: command.args.preparedId,
        expiresAt: command.args.expiresAt, payloadHash: command.args.payloadHash,
        sideEffect: 'composer-filled-no-send', clickedSend: false
      };
      else if (command.name === 'provider_commit') result = {
        clickedSend: true, requestId: command.args.requestId, preparedId: command.args.preparedId,
        payloadHash: command.args.payloadHash, clickedAt: new Date().toISOString(), baseline: 0, confirmed: true
      };
      else if (command.name === 'provider_reply_peek') result = {
        count:1, replyIndex:1, text:'Synthetic Claude reply for correlated request.',
        chars:46, generating:false, origin:'https://claude.ai',
        conversationId:'conversation_001', url:'https://claude.ai/chat/conversation_001'
      };
      else throw Error('Unexpected synthetic Bridge command: ' + command.name);
      const ack = await s.post('/bridge/result', { id: command.id, result }, 'b'.repeat(64));
      assert.equal(ack.status, 200);
    }
  })();
  try {
    const bound = await s.rpc('agent_bind', { name: 'claude', tabId: 42 });
    assert.equal(bound.result.isError, undefined);
    const transport = createChromeBridgeProviderTransport({
      endpoint: s.base, agentToken: 'a'.repeat(64), timeoutMs: 3000
    });
    const message = 'Review this synthetic ProviderTransport transaction.';
    const payloadHash = crypto.createHash('sha256').update(message, 'utf8').digest('hex');
    const identity = {
      requestId: 'request_0001', taskId: 'task_000001', providerId: 'claude',
      tabId: 42, origin: 'https://claude.ai', conversationId: 'conversation_001', epoch: 7
    };
    const prepared = await transport.prepare({ ...identity, message, payloadHash });
    assert.equal(prepared.state, 'PREPARED');
    assert.equal(prepared.clickedSend, false);
    assert.ok(prepared.fencingToken);
    const sent = await transport.commit({
      ...identity, preparedId: prepared.preparedId, fencingToken: prepared.fencingToken, payloadHash: prepared.payloadHash
    });
    assert.equal(sent.state, 'SENT');
    assert.equal(sent.clickedSend, true);
    assert.equal(sent.baseline, 0);
    assert.equal((await transport.status(identity)).state, 'SENT');
    const replied = await s.rpc('provider_reply_wait', { ...identity, timeoutSec: 5 });
    assert.equal(replied.result.isError, undefined);
    const reply = JSON.parse(replied.result.content[0].text);
    assert.equal(reply.state, 'REPLIED');
    assert.equal(reply.reply, 'Synthetic Claude reply for correlated request.');
    assert.equal(reply.replyReceipt.requestId, identity.requestId);
    assert.equal(reply.replyReceipt.providerId, identity.providerId);
    assert.equal(reply.replyReceipt.conversationId, identity.conversationId);
    assert.equal(reply.replyReceipt.baseline, 0);
    assert.equal(reply.replyReceipt.replyIndex, 1);
    assert.equal(reply.replyReceipt.stableSamples, 2);
    assert.ok(reply.replyReceipt.replySha256);
    assert.ok(reply.replyReceipt.eventId);
    assert.equal((await transport.status(identity)).state, 'REPLIED');
    const stoppedAfterCommit = await transport.stop(identity);
    assert.equal(stoppedAfterCommit.state, 'STOP_AFTER_COMMIT');
    assert.equal(stoppedAfterCommit.nextEpoch, 8);

    const events = await transport.events({ after: 0, limit: 100 });
    assert.ok(events.some(event => event.state === 'SENT' && event.requestId === identity.requestId));
    assert.ok(events.some(event => event.state === 'REPLIED' && event.requestId === identity.requestId));
    assert.ok(events.some(event => event.state === 'STOP_AFTER_COMMIT' && event.requestId === identity.requestId));
    assert.equal(responderError, null);
  } finally {
    running = false;
    await responder;
    await s.close();
  }
});

test('runtime MCP diagnostics expose a verifiable registry fingerprint',async()=>{
  const s=await setup();
  try {
    const browserStatus=JSON.parse((await s.rpc('browser_status')).result.content[0].text);
    assert.deepEqual(browserStatus.buildInfo,BUILD_INFO);
    assert.equal(browserStatus.buildInfo.version,VERSION);
    assert.equal(browserStatus.buildInfo.toolCount,registeredTools.length);
    assert.match(browserStatus.buildInfo.toolRegistrySha256,/^[a-f0-9]{64}$/);
    const expectedDigest=crypto.createHash('sha256')
      .update(JSON.stringify(registeredTools.map(({kind,...tool})=>tool)),'utf8').digest('hex');
    assert.equal(browserStatus.buildInfo.toolRegistrySha256,expectedDigest);

    const initialize=await s.post('/mcp',{
      jsonrpc:'2.0',id:22,method:'initialize',params:{protocolVersion:'2025-06-18'}
    }).then(response=>response.json());
    assert.match(initialize.result.instructions,/registryToolCount=/);
    assert.ok(initialize.result.instructions.includes(expectedDigest));

    const discovery=await s.post('/mcp',{
      jsonrpc:'2.0',id:23,method:'server/discover'
    }).then(response=>response.json());
    assert.deepEqual(discovery.result.buildInfo,BUILD_INFO);
  } finally { await s.close(); }
});
