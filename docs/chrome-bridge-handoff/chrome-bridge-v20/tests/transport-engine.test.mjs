import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeTransport } from '../extension/transport-engine.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const jsonResponse = (body, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('allows only one poll loop and clears credentials on explicit stop', async () => {
  let calls = 0;
  const t = new BridgeTransport({
    fetchImpl: async (_, options) => {
      calls++;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Error('aborted')), { once:true });
      });
    },
    execute: async () => ({ ok:true })
  });
  assert.equal(await t.start('secret'), true);
  assert.equal(await t.start('secret'), false);
  await tick();
  assert.equal(calls, 1);
  t.stop();
  assert.equal(t.token, null);
  assert.equal(t.lastStatus.state, 'disconnected');
});

test('auth rejection does not loop or save a credential', async () => {
  let calls = 0;
  const statuses = [];
  const t = new BridgeTransport({
    fetchImpl: async () => { calls++; return jsonResponse({}, 401); },
    execute: async () => ({}),
    onStatus: s => statuses.push(s.state)
  });
  await t.start('secret');
  await tick();
  assert.equal(calls, 1);
  assert.equal(t.active, false);
  assert.equal(t.lastStatus.state, 'auth-failed');
  assert.equal(t.token, null);
  assert.deepEqual(statuses, ['connecting', 'auth-failed']);
});

test('command executes once when result acknowledgement is uncertain', async () => {
  let executeCalls = 0;
  let pollCalls = 0;
  let resultCalls = 0;
  const t = new BridgeTransport({
    fetchImpl: async (url, options) => {
      if (url.endsWith('/bridge/result')) {
        resultCalls++;
        if (resultCalls === 1) throw Error('connection reset after execution');
        return jsonResponse({ ok:true });
      }
      pollCalls++;
      if (pollCalls === 1) {
        return jsonResponse({ epoch:'e1', command: {
          id:'cmd1', name:'agent_send', args:{}, expires:Date.now()+120000
        }});
      }
      return new Promise((resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once:true }));
    },
    execute: async () => { executeCalls++; return { ok:true }; }
  });
  await t.start('secret');
  for (let i=0;i<20 && pollCalls<2;i++) await tick();
  assert.equal(executeCalls, 1);
  assert.equal(resultCalls, 1);
  assert.equal(pollCalls, 2);
  t.stop();
});
test('expired command is rejected without execution', async () => {
  let executed = false;
  let result = null;
  const t = new BridgeTransport({
    fetchImpl: async (url, options) => {
      if (url.endsWith('/bridge/result')) {
        result = JSON.parse(options.body);
        return jsonResponse({ ok:true });
      }
      if (!result) return jsonResponse({ epoch:'e1', command: { id:'old', name:'browser_read', args:{}, expires:Date.now()-1 }});
      t.stop();
      return jsonResponse({ epoch:'e1' });
    },
    execute: async () => { executed=true; }
  });
  await t.start('secret');
  for(let i=0;i<20 && !result;i++) await tick();
  assert.equal(executed, false);
  assert.equal(result.error, 'Command expired');
  t.stop();
});
