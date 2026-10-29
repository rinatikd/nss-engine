import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server/bridge.mjs';
import { EXT_TIMEOUTS } from '../server/tools.mjs';

const origin = 'https://claude.ai';
const context = conversationId => ({ verified: true, origin, conversationId });

async function fixture(t, options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-machine-'));
  fs.writeFileSync(path.join(stateDir, 'agents.json'), JSON.stringify({ primary: 7, alias: 7, other: 8 }));
  const config = { agentToken: 'a'.repeat(64), browserToken: 'b'.repeat(64) };
  let server, base;
  async function start() {
    server = createBridge(config, { stateDir, timeout: 1000, pollHold: 15, settleMs: 0, pollMs: 1, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const stop = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await start();
  t.after(async () => {
    await stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const post = async (route, body, browser = false) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      authorization: `Bearer ${browser ? config.browserToken : config.agentToken}`,
      'content-type': 'application/json',
    }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  let id = 0;
  const call = async (name, args = {}) => {
    const { data } = await post('/mcp', { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    return data.result.isError ? { error: data.result.content[0].text } : JSON.parse(data.result.content[0].text);
  };
  const poll = async () => (await post('/bridge/poll', {}, true)).data.command;
  const result = (command, value) => post('/bridge/result', { id: command.id, result: value }, true);
  await post('/bridge/poll', { hello: true }, true);
  async function dispatch(name, args, value) {
    const response = call(name, args);
    const command = await poll();
    assert.equal(command.name, name);
    await result(command, value);
    return response;
  }
  async function send(name, requestId, conversationId = 'original-12345678') {
    const response = call('agent_send', { name, requestId, text: 'Synthetic state machine request' });
    const probe = await poll();
    assert.equal(probe.name, 'agent_context');
    await result(probe, context(conversationId));
    const command = await poll();
    assert.equal(command.name, 'agent_send');
    await result(command, { baseline: 0, confirmed: true });
    assert.equal((await response).sent, true);
  }
  return { call, poll, result, dispatch, send, post, async restart() { await stop(); await start(); } };
}

test('explicit new chat clears pending state for every alias of its tab', async t => {
  const f = await fixture(t);
  await f.send('primary', 'before-new-chat');
  assert.deepEqual(await f.dispatch('agent_new_chat', { name: 'alias' }, { ok: true }), { ok: true });
  const response = f.call('agent_send', { name: 'alias', requestId: 'after-new-chat', text: 'Synthetic state machine request' });
  const command = await f.poll();
  assert.equal(command?.name, 'agent_context', 'successful navigation must release the previous conversation for all aliases');
  await f.result(command, context('new-conversation-12345678'));
  const send = await f.poll();
  await f.result(send, { baseline: 0, confirmed: true });
  assert.equal((await response).sent, true);
});

test('late active results cannot settle a later command after deadline expiry', async t => {
  const f = await fixture(t, { timeout: 400 });
  const activeResponse = f.call('browser_tabs');
  const active = await f.poll();
  assert.equal(active.name, 'browser_tabs');
  const sendResponse = f.call('agent_send', { name: 'primary', requestId: 'queued-context', text: 'Synthetic state machine request' });
  assert.match((await activeResponse).error, /Command expired/);
  // The queued context may be dispatched when the active command expires; either
  // way no send occurs, and its eventual failure must release the reservation.
  assert.match((await sendResponse).error, /Command expired/);
  assert.equal((await f.result(active, [])).status, 410);
  const nextResponse = f.call('browser_tabs');
  const next = await f.poll();
  assert.notEqual(next.id, active.id);
  assert.equal((await f.result(active, [])).status, 410);
  await f.result(next, [{ tabId: 7 }]);
  assert.deepEqual(await nextResponse, [{ tabId: 7 }]);
});

test('a send that expires behind another active command is never dispatched or replayed', async t => {
  const saved = { ...EXT_TIMEOUTS };
  EXT_TIMEOUTS.browser_tabs = 2000;
  EXT_TIMEOUTS.agent_send = 300;
  t.after(() => {
    for (const key of Object.keys(EXT_TIMEOUTS)) delete EXT_TIMEOUTS[key];
    Object.assign(EXT_TIMEOUTS, saved);
  });
  const f = await fixture(t, { timeout: undefined });
  const args = { name: 'primary', requestId: 'queued-send-expiry', text: 'Synthetic state machine request' };
  const response = f.call('agent_send', args);
  const probe = await f.poll();
  const blockingResponse = f.call('browser_tabs');
  // Observe the second command at the HTTP boundary before releasing context.
  for (let tries = 0; ; tries++) {
    if ((await f.call('browser_status')).queued === 2) break;
    assert.ok(tries < 100, 'blocking command must enter the queue');
  }
  await f.result(probe, context('original-12345678'));
  const blocking = await f.poll();
  assert.equal(blocking.name, 'browser_tabs');
  const expired = await response;
  assert.equal(expired.sent, false);
  assert.equal(expired.transportConfirmed, false);
  assert.equal(expired.deliveryStatus, 'NOT_PERFORMED');
  assert.equal((await f.call('agent_send', args)).duplicate, true);
  assert.equal(await f.poll(), null, 'expired send must not be dispatched');
  await f.result(blocking, []);
  assert.deepEqual(await blockingResponse, []);
  assert.equal((await f.call('browser_status')).queued, 0);
});

test('a dispatched send timeout remains UNKNOWN and its request ID stays consumed', async t => {
  const f = await fixture(t, { timeout: 400 });
  const args = { name: 'primary', requestId: 'active-send-expiry', text: 'Synthetic state machine request' };
  const response = f.call('agent_send', args);
  const probe = await f.poll();
  await f.result(probe, context('original-12345678'));
  const command = await f.poll();
  assert.equal(command.name, 'agent_send');
  assert.equal((await response).deliveryStatus, 'UNKNOWN');
  assert.equal((await f.result(command, { baseline: 0, confirmed: true })).status, 410);
  const duplicate = await f.call('agent_send', args);
  assert.equal(duplicate.sent, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.transportConfirmed, false);
  assert.equal(duplicate.deliveryStatus, 'UNKNOWN');
  assert.equal((await f.call('browser_status')).queued, 0);
  await f.restart();
  assert.equal((await f.call('browser_status')).connected, false);
  const durable = await f.call('agent_send', args);
  assert.equal(durable.duplicate, true);
  assert.equal(durable.sent, false);
  assert.equal(durable.deliveryStatus, 'UNKNOWN');
  assert.match((await f.call('agent_send', { ...args, text: 'Changed synthetic request' })).error, /SEND_ID_CONFLICT/);
  assert.equal((await f.call('browser_status')).queued, 0, 'durable replay must not query a disconnected extension');
  assert.equal(await f.poll(), null, 'reconnecting must not replay the expired send');
});

test('new chat invalidates cached replies for its aliases and preserves other tabs', async t => {
  const f = await fixture(t);
  const completed = {};
  for (const name of ['primary', 'other']) {
    await f.send(name, `${name}-cache`);
    const response = f.call('agent_wait', { name, timeoutSec: 1 });
    const peek = await f.poll();
    assert.equal(peek.name, 'agent_peek');
    await f.result(peek, { count: 1, text: `Synthetic reply for ${name}`, generating: false, context: context('original-12345678') });
    completed[name] = await response;
    assert.equal(completed[name].done, true);
    assert.equal(completed[name].replyAttribution, 'UNVERIFIED');
    assert.deepEqual(await f.call('agent_wait', { name, timeoutSec: 1 }), completed[name]);
  }
  await f.dispatch('agent_new_chat', { name: 'alias' }, { ok: true });
  assert.match((await f.call('agent_wait', { name: 'primary', timeoutSec: 1 })).error, /Nothing was sent/);
  assert.deepEqual(await f.call('agent_wait', { name: 'other', timeoutSec: 1 }), completed.other);
  assert.equal((await f.call('browser_status')).queued, 0);
});

test('wait cannot report the previous cached reply while a new send is in progress', async t => {
  const f = await fixture(t);
  await f.send('primary', 'old-cached-reply');
  const oldWait = f.call('agent_wait', { name: 'primary', timeoutSec: 1 });
  const peek = await f.poll();
  await f.result(peek, { count: 1, text: 'Previous request reply', generating: false, context: context('original-12345678') });
  assert.equal((await oldWait).done, true);
  const response = f.call('agent_send', { name: 'primary', requestId: 'new-send-pending', text: 'Synthetic new request' });
  const probe = await f.poll();
  assert.equal(probe.name, 'agent_context');
  const waiting = await f.call('agent_wait', { name: 'primary', timeoutSec: 1 });
  await f.result(probe, context('original-12345678'));
  const send = await f.poll();
  await f.result(send, { baseline: 1, confirmed: true });
  assert.equal((await response).sent, true);
  assert.match(waiting.error || '', /send.*in progress/i, 'an in-flight new request must not return the previous completed reply');
});

test('an alias cannot navigate or bind while another alias discovers send context', async t => {
  const f = await fixture(t);
  const response = f.call('agent_send', { name: 'primary', requestId: 'alias-reservation', text: 'Synthetic state machine request' });
  const probe = await f.poll();
  assert.equal(probe.name, 'agent_context');
  assert.match((await f.call('agent_new_chat', { name: 'alias' })).error, /operation is in progress/);
  assert.match((await f.call('agent_bind', { name: 'alias', tabId: 7 })).error, /request is pending/);
  assert.match((await f.call('agent_send', { name: 'alias', requestId: 'alias-overlap', text: 'Synthetic state machine request' })).error, /Previous request is still pending/);
  await f.result(probe, context('original-12345678'));
  const send = await f.poll();
  await f.result(send, { baseline: 0, confirmed: true });
  assert.equal((await response).sent, true);
});
