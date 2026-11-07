import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server/bridge.mjs';

// This test runs the REAL HTTP/MCP server with synthetic credentials and an
// in-process command responder. No real Chrome profile, AI site, or Windows
// production endpoint is contacted.
test('two concurrent send requests to one agent dispatch at most once', { timeout: 15000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-concurrency-'));
  const config = {
    agentToken: crypto.randomBytes(32).toString('hex'),
    browserToken: crypto.randomBytes(32).toString('hex'),
    extensionId: 'a'.repeat(32)
  };
  const server = createBridge(config, { stateDir, timeout: 4000, pollHold: 60 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const controller = new AbortController();
  let running = true;
  let sendDispatches = 0;
  let releaseContext;
  let signalContext;
  const contextReached = new Promise(resolve => { signalContext = resolve; });
  const contextGate = new Promise(resolve => { releaseContext = resolve; });
  let deferContext = false;
  let workerError = null;
  const post = async (route, payload, browser = false) => {
    const response = await fetch(endpoint + route, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (browser ? config.browserToken : config.agentToken),
        ...(browser ? { origin: 'chrome-extension://' + config.extensionId } : {})
      },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200, route + ' HTTP status');
    return response.json();
  };
  const call = async (name, args, id) => {
    const response = await post('/mcp', {
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name, arguments: args }
    });
    const r = response.result;
    return { error: r.isError ? r.content[0].text : null,
      value: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  const responder = (async () => {
    while (running) {
      let item;
      try { item = await post('/bridge/poll', {}, true); }
      catch (error) {
        if (!running || controller.signal.aborted) break;
        workerError = error;
        break;
      }
      if (!item.command) continue;
      const cmd = item.command;
      if (cmd.name === 'agent_context' && deferContext) {
        signalContext();
        await contextGate;
      }
      let result;
      if (cmd.name === 'agent_probe') result = { adapter: 'claude', verified: true };
      else if (cmd.name === 'agent_context') result = {
        verified: true, origin: 'https://claude.ai',
        conversationId: 'test-conversation-12345678'
      };
      else if (cmd.name === 'agent_send') {
        sendDispatches++;
        result = { sent: true, baseline: 0, confirmed: true };
      } else throw Error('Unexpected command: ' + cmd.name);
      try { await post('/bridge/result', { id: cmd.id, result }, true); }
      catch (error) {
        if (!running || controller.signal.aborted) break;
        workerError = error;
        break;
      }
    }
  })();
  try {
    const binding = await call('agent_bind', { name: 'claude', tabId: 123 }, 1);
    assert.equal(binding.error, null);
    assert.equal(binding.value.bound, 'claude');

    deferContext = true;
    const first = call('agent_send', {
      name: 'claude', text: 'Synthetic first request', requestId: 'req-first'
    }, 2);
    // The first call is paused after the server dispatched its context preflight.
    await contextReached;
    const second = await call('agent_send', {
      name: 'claude', text: 'Synthetic concurrent request', requestId: 'req-second'
    }, 3);
    assert.match(second.error || '', /Previous request is still pending/);
    releaseContext();
    const result = await first;
    assert.equal(result.error, null);
    assert.equal(result.value.sent, true);
    assert.equal(sendDispatches, 1, 'only one browser send may be dispatched');

    // Same request ID after an ACK must never dispatch again.
    const duplicate = await call('agent_send', {
      name: 'claude', text: 'Synthetic first request', requestId: 'req-first'
    }, 4);
    assert.equal(duplicate.error, null);
    assert.equal(duplicate.value.duplicate, true);
    assert.equal(sendDispatches, 1);
    assert.equal(workerError, null);
  } finally {
    releaseContext?.();
    running = false;
    controller.abort();
    await responder;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});


test('lost browser ACK returns UNKNOWN and identical requestId cannot send twice', { timeout: 15000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lost-ack-'));
  const config = {
    agentToken: crypto.randomBytes(32).toString('hex'),
    browserToken: crypto.randomBytes(32).toString('hex'),
    extensionId: 'b'.repeat(32)
  };
  const server = createBridge(config, { stateDir, timeout: 350, pollHold: 40 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const controller = new AbortController();
  let running = true, sendDispatches = 0;
  let workerError = null;
  const post = async (route, body, browser = false) => {
    const response = await fetch(endpoint + route, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (browser ? config.browserToken : config.agentToken),
        ...(browser ? { origin: 'chrome-extension://' + config.extensionId } : {})
      },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const call = async (name, args, id) => {
    const r = await post('/mcp', {
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name, arguments: args }
    });
    return { error: r.result.isError ? r.result.content[0].text : null,
      value: r.result.isError ? null : JSON.parse(r.result.content[0].text) };
  };
  const responder = (async () => {
    while (running) {
      let item;
      try { item = await post('/bridge/poll', {}, true); }
      catch (error) {
        if (!running || controller.signal.aborted) break;
        workerError = error; break;
      }
      if (!item.command) continue;
      const cmd = item.command;
      if (cmd.name === 'agent_send') {
        // The browser received this command but its result/ACK was lost.
        sendDispatches++;
        continue;
      }
      const result = cmd.name === 'agent_probe'
        ? { adapter: 'claude', verified: true }
        : cmd.name === 'agent_context'
          ? { verified: true, origin: 'https://claude.ai',
              conversationId: 'synthetic-conversation-1234' }
          : null;
      if (!result) throw Error('Unexpected command: ' + cmd.name);
      try { await post('/bridge/result', { id: cmd.id, result }, true); }
      catch (error) {
        if (!running || controller.signal.aborted) break;
        workerError = error; break;
      }
    }
  })();
  try {
    const bound = await call('agent_bind', { name: 'claude', tabId: 456 }, 11);
    assert.equal(bound.error, null);
    const payload = {
      name: 'claude', text: 'Synthetic lost ACK request', requestId: 'req-lost-ack'
    };
    const first = await call('agent_send', payload, 12);
    assert.equal(first.error, null);
    assert.equal(first.value.sent, false);
    assert.equal(first.value.deliveryStatus, 'UNKNOWN');
    assert.equal(sendDispatches, 1);
    const retry = await call('agent_send', payload, 13);
    assert.equal(retry.error, null);
    assert.equal(retry.value.duplicate, true);
    assert.equal(retry.value.deliveryStatus, 'UNKNOWN');
    assert.equal(sendDispatches, 1, 'identical requestId must not redispatch');
    const journal = fs.readFileSync(path.join(stateDir, 'send-journal.json'), 'utf8');
    assert.ok(!journal.includes(payload.text), 'do not persist prompt text');
    assert.equal(workerError, null);
  } finally {
    running = false;
    controller.abort();
    await responder;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
