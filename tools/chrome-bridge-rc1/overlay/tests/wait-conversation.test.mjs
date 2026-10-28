import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server/bridge.mjs';
import { pageAction } from '../extension/page.js';

const origin = 'https://claude.ai';
const originalConversation = 'original-12345678';
const request = { name: 'claude', text: 'Synthetic request for conversation A', requestId: 'wait-context-check' };

test('actual page peek includes conversation identity beside its observed reply', async () => {
  const saved = new Map(['location', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const reply = { getClientRects: () => [1], innerText: 'Observed reply from A' };
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true,
    value: { origin, pathname: `/chat/${originalConversation}`, href: `${origin}/chat/${originalConversation}` } });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true,
    value: { querySelectorAll: selector => selector === '#reply' ? [reply] : [] } });
  try {
    const result = await pageAction('agent_peek', { adapter: { reply: '#reply', composer: '#composer', stop: '#stop' } }, origin);
    assert.equal(result.text, reply.innerText);
    assert.deepEqual(result.context, { verified: true, origin, conversationId: originalConversation });
    location.pathname = '/new';
    const unverified = await pageAction('agent_peek', { adapter: { reply: '#reply', composer: '#composer', stop: '#stop' } }, origin);
    assert.deepEqual(unverified.context, { verified: false, origin, conversationId: null });
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

async function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-wait-context-'));
  fs.writeFileSync(path.join(stateDir, 'agents.json'), JSON.stringify({ claude: 7 }));
  const config = { agentToken: 'a'.repeat(64), browserToken: 'b'.repeat(64) };
  let session, sends = 0, conversationId = originalConversation, peekContext = true;
  async function start() {
    const bridge = createBridge(config, { stateDir, timeout: 1000, pollHold: 10, settleMs: 0, pollMs: 1 });
    await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${bridge.address().port}`;
    const abort = new AbortController();
    const commands = [];
    const post = async (route, body, token = config.agentToken, signal) => {
      const response = await fetch(base + route, { method: 'POST', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return response.json();
    };
    const pump = (async () => {
      while (!abort.signal.aborted) {
        const { command } = await post('/bridge/poll', {}, config.browserToken, abort.signal);
        if (!command) continue;
        commands.push(command.name);
        let result;
        const context = { verified: true, origin, conversationId };
        if (command.name === 'agent_context') result = context;
        else if (command.name === 'agent_send') { sends++; result = { baseline: 0, confirmed: true }; }
        else if (command.name === 'agent_peek') result = { count: 1, text: `Reply from ${conversationId}`, generating: false,
          url: `${origin}/chat/${conversationId}`, ...(peekContext ? { context } : {}) };
        else throw Error(`Unexpected command: ${command.name}`);
        await post('/bridge/result', { id: command.id, result }, config.browserToken, abort.signal);
      }
    })().catch(error => { if (!abort.signal.aborted) throw error; });
    await post('/bridge/poll', {}, config.browserToken);
    session = { commands,
      async call(name, args) {
        const response = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
        return response.result.isError ? { error: response.result.content[0].text } : JSON.parse(response.result.content[0].text);
      },
      async stop() {
        abort.abort(); await pump;
        await new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections(); });
      },
    };
    return session;
  }
  t.after(async () => { if (session) await session.stop(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { start, stateDir, sends: () => sends,
    navigate: () => { conversationId = 'different-12345678'; },
    omitContext: () => { peekContext = false; } };
}

test('agent_wait completes only for the original conversation snapshot', async t => {
  const f = await fixture(t), session = await f.start();
  assert.equal((await session.call('agent_send', request)).sent, true);
  const result = await session.call('agent_wait', { name: 'claude', timeoutSec: 1 });
  assert.equal(result.done, true);
  assert.equal(result.reply, `Reply from ${originalConversation}`);
  assert.equal(f.sends(), 1);
});

test('manual same-origin navigation makes agent_wait fail closed without another send', async t => {
  const f = await fixture(t), session = await f.start();
  await session.call('agent_send', request);
  f.navigate();
  const result = await session.call('agent_wait', { name: 'claude', timeoutSec: 1 });
  assert.match(result.error, /WAIT_CONTEXT_CHANGED_OR_UNVERIFIED.*do not resubmit automatically/i);
  assert.equal(result.reply, undefined);
  assert.equal(f.sends(), 1);
});

test('durable duplicate replay preserves original wait context across restart', async t => {
  const f = await fixture(t);
  let session = await f.start();
  const original = await session.call('agent_send', request);
  await session.stop();
  f.navigate();
  session = await f.start();
  const duplicate = await session.call('agent_send', request);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sent, false);
  assert.equal(duplicate.conversationFingerprint, original.conversationFingerprint);
  const result = await session.call('agent_wait', { name: 'claude', timeoutSec: 1 });
  assert.match(result.error, /WAIT_CONTEXT_CHANGED_OR_UNVERIFIED/);
  assert.deepEqual(session.commands, ['agent_peek']);
  assert.equal(f.sends(), 1);
});

test('a peek without atomic conversation metadata cannot complete a wait', async t => {
  const f = await fixture(t), session = await f.start();
  await session.call('agent_send', request);
  f.omitContext();
  assert.match((await session.call('agent_wait', { name: 'claude', timeoutSec: 1 })).error, /WAIT_CONTEXT_CHANGED_OR_UNVERIFIED/);
  assert.equal(f.sends(), 1);
});

test('legacy durable entries without conversation identity remain consumed and cannot restore a valid wait', async t => {
  const f = await fixture(t);
  let session = await f.start();
  await session.call('agent_send', request);
  await session.stop();
  const file = path.join(f.stateDir, 'send-journal.json');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = journal.entries[request.requestId];
  entry.fingerprint = entry.payloadFingerprint;
  for (const key of ['identityVersion', 'payloadFingerprint', 'origin', 'conversationFingerprint']) delete entry[key];
  journal.version = 1;
  fs.writeFileSync(file, JSON.stringify(journal));
  session = await f.start();
  assert.equal((await session.call('agent_send', request)).duplicate, true);
  assert.match((await session.call('agent_wait', { name: 'claude', timeoutSec: 1 })).error, /WAIT_CONTEXT_UNAVAILABLE.*do not resubmit automatically/i);
  assert.deepEqual(session.commands, []);
  assert.equal(f.sends(), 1);
});
