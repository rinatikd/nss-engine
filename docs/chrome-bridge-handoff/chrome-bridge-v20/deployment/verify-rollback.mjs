// Synthetic-only rollback compatibility verifier.
// Never reads user profiles, credentials, Production files, or fixed Production ports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'integration-reports/rollback-recovery');
const candidate = path.join(root, 'rollback-candidates/v020-cors-recovered');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-verify-synthetic-'));
const config = {
  agentToken: 'synthetic-rollback-agent-token-only',
  browserToken: 'synthetic-rollback-browser-token-only'
};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config), { mode: 0o600, flag: 'wx' });

const request = async (url, token, body, extra = {}) => fetch(url, {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(5000),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra },
  body: JSON.stringify(body)
});
const rpc = async (base, token, method, params) => {
  const response = await request(base + '/mcp', token, {
    jsonrpc: '2.0', id: 1, method, params
  });
  assert.equal(response.status, 200);
  return response.json();
};
async function startBridge(modulePath) {
  const moduleUrl = pathToFileURL(modulePath).href;
  const module = await import(moduleUrl);
  const loadedConfig = module.loadConfig(state);
  assert.deepEqual(loadedConfig, config);
  const server = module.createBridge(loadedConfig, {
    stateDir: state, pollHold: 60, timeout: 1500
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
try {
  const candidateModule = path.join(candidate, 'server/bridge.mjs');
  const currentModule = path.join(root, 'server/bridge.mjs');

  const original = await startBridge(candidateModule);
  const candidateList = await rpc(original.url, config.agentToken, 'tools/list');
  assert.equal(candidateList.result.tools.length, 15);
  assert.equal((await request(original.url + '/mcp', 'wrong-synthetic-token', {})).status, 401);
  assert.deepEqual(await rpc(original.url, config.agentToken, 'ping'), {
    jsonrpc: '2.0', id: 1, result: {}
  });

  // Establish a synthetic browser heartbeat first; the bridge correctly
  // rejects extension commands until a browser poll has been observed.
  const idlePoll = await request(original.url + '/bridge/poll', config.browserToken, {});
  assert.equal(idlePoll.status, 200);
  assert.equal((await idlePoll.json()).command, null);

  const pending = rpc(original.url, config.agentToken, 'tools/call', {
    name: 'browser_tabs', arguments: {}
  });
  let command = null;
  for (let attempt = 0; attempt < 40 && !command; attempt++) {
    const pollResponse = await request(original.url + '/bridge/poll', config.browserToken, {});
    assert.equal(pollResponse.status, 200);
    command = (await pollResponse.json()).command;
    if (!command) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(command, 'synthetic browser queue command was not delivered before the bounded deadline');
  assert.equal(command.name, 'browser_tabs');
  const resultResponse = await request(original.url + '/bridge/result', config.browserToken, {
    id: command.id,
    result: [{ tabId: 1, title: 'synthetic-only' }]
  });
  assert.equal(resultResponse.status, 200);
  assert.deepEqual((await pending).result.content[0].text, JSON.stringify([{ tabId: 1, title: 'synthetic-only' }]));
  await original.close();

  const upgraded = await startBridge(currentModule);
  const upgradedList = await rpc(upgraded.url, config.agentToken, 'tools/list');
  assert.ok(upgradedList.result.tools.length > candidateList.result.tools.length,
    'the candidate and current server registries must be distinguishable without pinning a stale tool count');
  const codex = await rpc(upgraded.url, config.agentToken, 'tools/call', {
    name: 'codex_submit',
    arguments: { requestId: 'synthetic-rehearsal', workspace: 'source', prompt: 'synthetic disabled probe' }
  });
  assert.equal(codex.result.isError, true);
  assert.equal(typeof codex.result.content[0].text, 'string');
  assert.ok(codex.result.content[0].text.length > 0,
    'CLI invocation must fail closed because no codexJobs executor is injected into this synthetic bridge');
  await upgraded.close();

  const restored = await startBridge(candidateModule);
  const restoredList = await rpc(restored.url, config.agentToken, 'tools/list');
  assert.deepEqual(restoredList, candidateList);
  await restored.close();

  const report = {
    ok: true,
    target: 'SYNTHETIC_TEMP_STATE_ONLY',
    candidateToolCount: candidateList.result.tools.length,
    upgradedToolCount: upgradedList.result.tools.length,
    restoredToolCount: restoredList.result.tools.length,
    syntheticStateSha256: sha(fs.readFileSync(path.join(state, 'config.json'))),
    checks: [
      'synthetic config only',
      'wrong token denied',
      'candidate tool registry and ping',
      'synthetic browser_tabs queue/poll/result round-trip',
      'candidate to current-server compatibility',
      'CLI tool call fails closed because no executor is injected',
      'candidate rollback compatibility after server restart'
    ]
  };
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2));
  console.log('PASS: synthetic-only rollback compatibility; no user profile or Production resources accessed.');
} finally {
  fs.rmSync(state, { recursive: true, force: true });
}
