// Loopback fixtures and temporary private state only; no live sites or AI calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyLive, REQUIRED_TOOLS } from '../scripts/verify-live.mjs';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const config = { agentToken: 'a'.repeat(64), browserToken: 'b'.repeat(64), extensionId: 'a'.repeat(32), preserved: { custom: true } };
const privateText = 'PRIVATE_FIXTURE_CONTENT_MUST_NOT_LEAK';
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-helper-selftest-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'config.json');
  const original = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(file, original, { mode: 0o600 });
  const env = { ...process.env, CHROME_BRIDGE_HOME: home, CHROME_BRIDGE_PORT: '17381' };
  delete env.CHROME_BRIDGE_EXTENSION_ID;
  return { home, file, original, env };
}
function run(helper, args, env, nodeArgs = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...nodeArgs, path.join(scripts, helper), ...args], { env });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('close', code => resolve({ code, output }));
  });
}
async function endpoint(t, respond) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw); calls.push(message);
    await respond(message, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { calls, port: server.address().port };
}
function reply(message, res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: value }));
}
function ready(message, res, custom) {
  const name = message.params?.name;
  if (custom?.(message, res)) return;
  let value;
  if (message.method === 'initialize') value = { serverInfo: { name: 'chrome-bridge' }, capabilities: { tools: {} } };
  else if (message.method === 'tools/list') value = { tools: REQUIRED_TOOLS.map(name => ({ name })) };
  else if (name === 'browser_status') value = { connected: true };
  else if (name === 'agent_list') value = { bound: [{ name: 'test', alive: true }], chatTabs: [] };
  else if (name === 'agent_selftest') value = Object.fromEntries(['composer', 'send', 'stop', 'reply'].map(key => [key, { matched: key === 'stop' ? 0 : 1, visible: key === 'stop' ? 0 : 1 }]));
  else value = { done: false, sent: true };
  reply(message, res, message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify(value) }] } : value);
}

test('helper fixture runs a complete release and preserves tokens and custom configuration', t => {
  const { file, env } = sandbox(t);
  const result = spawnSync(process.execPath, [path.join(scripts, 'windows-local.mjs'), 'setup', '--extension-id', 'b'.repeat(32)], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...config, extensionId: 'b'.repeat(32) });
});

test('conflicting explicit setup pin fails before modifying existing private state', t => {
  const { file, original, env } = sandbox(t);
  env.CHROME_BRIDGE_EXTENSION_ID = 'c'.repeat(32);
  const result = spawnSync(process.execPath, [path.join(scripts, 'windows-local.mjs'), 'setup', '--extension-id', 'b'.repeat(32)], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(!(result.stdout + result.stderr).includes(config.agentToken));
});

test('failed setup write preserves complete prior config and leaves no temporary private files', t => {
  const { home, file, original, env } = sandbox(t);
  const preload = path.join(home, 'fail-write.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';\nconst original = fs.writeFileSync;\nfs.writeFileSync = (file, data, ...args) => {\n  if (typeof data === 'string' && data.includes('agentToken')) { original(file, data.slice(0, 12), ...args); throw Error('PRIVATE_FIXTURE_CONTENT_MUST_NOT_LEAK'); }\n  return original(file, data, ...args);\n};\n`);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scripts, 'windows-local.mjs'), 'setup', '--extension-id', 'b'.repeat(32)], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(home).sort(), ['config.json', 'fail-write.mjs']);
  assert.ok(!(result.stdout + result.stderr).includes(privateText));
});

test('doctor rejects a connected-looking response with the wrong JSON-RPC version', async t => {
  const { env } = sandbox(t);
  const { port } = await endpoint(t, (message, res) => res.end(JSON.stringify({ jsonrpc: '1.0', id: message.id, result: { content: [{ type: 'text', text: '{"connected":true}' }] } })));
  env.CHROME_BRIDGE_PORT = String(port);
  const result = await run('windows-local.mjs', ['doctor', '--live'], env);
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, /PASS: authenticated/);
});

test('acceptance refuses existing reports and private config without replacing evidence', async t => {
  const { home, file, original, env } = sandbox(t);
  const report = path.join(home, 'proof.json');
  fs.writeFileSync(report, privateText);
  for (const output of [report, file]) {
    const result = await run('verify-live.mjs', ['--report', output], env);
    assert.equal(result.code, 1);
    assert.ok(!result.output.includes(privateText));
    assert.ok(!result.output.includes(config.agentToken));
  }
  assert.equal(fs.readFileSync(report, 'utf8'), privateText);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('acceptance rejects HTTP errors, redirects, invalid JSON and wrong response IDs without private output', async t => {
  for (const mode of ['http', 'redirect', 'json', 'id']) {
    const { calls, port } = await endpoint(t, (message, res) => {
      if (mode === 'http') { res.writeHead(401); res.end(privateText); }
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' + privateText }); res.end(); }
      if (mode === 'json') res.end(privateText);
      if (mode === 'id') res.end(JSON.stringify({ jsonrpc: '2.0', id: 'wrong', error: { message: privateText } }));
    });
    const report = await verifyLive({ config, port, agent: 'test', sendTest: true });
    assert.equal(report.passed, false);
    assert.equal(report.sendTest.attempted, false);
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(report).includes(privateText));
    assert.ok(!JSON.stringify(report).includes(config.agentToken));
  }
});

test('acceptance rejects simultaneous result and null error instead of claiming success', async t => {
  const { calls, port } = await endpoint(t, (message, res) => {
    if (message.method === 'initialize') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: null,
        result: { serverInfo: { name: 'chrome-bridge' }, capabilities: { tools: {} } } }));
    } else ready(message, res);
  });
  const report = await verifyLive({ config, port });
  assert.equal(report.passed, false);
  assert.equal(report.failureCode, 'MCP_RESPONSE_REJECTED');
  assert.equal(report.authenticatedMcp, false);
  assert.equal(calls.length, 1);
});

test('lost send response times out with a durable request ID and never sends again', async t => {
  const { home, env } = sandbox(t);
  const output = path.join(home, 'timeout-proof.json');
  let persistedId;
  const { calls, port } = await endpoint(t, (message, res) => ready(message, res, message => {
    if (message.params?.name !== 'agent_ask') return false;
    const preSend = JSON.parse(fs.readFileSync(output));
    persistedId = preSend.sendTest.requestId;
    assert.equal(persistedId, message.params.arguments.requestId);
    assert.equal(preSend.sendTest.attempted, true);
    return true; // Leave the response pending to model lost acknowledgement.
  }));
  env.CHROME_BRIDGE_PORT = String(port);
  const result = await run('verify-live.mjs', ['--report', output, '--agent', 'test', '--send-test', '--timeout-sec', '1'], env);
  assert.equal(result.code, 1);
  const report = JSON.parse(fs.readFileSync(output));
  assert.equal(report.failureCode, 'LOCAL_BRIDGE_UNREACHABLE_OR_TIMEOUT');
  assert.equal(report.sendTest.requestId, persistedId);
  assert.equal(report.sendTest.autoResend, false);
  assert.equal(calls.filter(message => message.params?.name === 'agent_ask').length, 1);
  assert.equal(calls.filter(message => ['agent_send', 'agent_wait'].includes(message.params?.name)).length, 0);
  assert.ok(!result.output.includes(config.agentToken));
  assert.deepEqual(fs.readdirSync(home).sort(), ['config.json', 'timeout-proof.json']);
});

test('short report writes cannot discard the persisted request ID before the sending call', async t => {
  const { home, env } = sandbox(t);
  const output = path.join(home, 'proof.json');
  const preload = path.join(home, 'short-write.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';\nconst original = fs.writeSync;\nfs.writeSync = (descriptor, data, ...args) => original(descriptor, typeof data === 'string' ? data.slice(0, 12) : data, ...args);\n`);
  let persisted;
  const { port } = await endpoint(t, (message, res) => ready(message, res, (message, res) => {
    if (message.params?.name !== 'agent_ask') return false;
    persisted = fs.readFileSync(output, 'utf8');
    const nonce = message.params.arguments.text.split(' ').at(-1);
    reply(message, res, { content: [{ type: 'text', text: JSON.stringify({ done: true, reply: nonce }) }] });
    return true;
  }));
  env.CHROME_BRIDGE_PORT = String(port);
  const result = await run('verify-live.mjs', ['--report', output, '--agent', 'test', '--send-test'], env, ['--import', pathToFileURL(preload).href]);
  assert.equal(result.code, 0, result.output);
  const final = JSON.parse(fs.readFileSync(output));
  assert.equal(JSON.parse(persisted).sendTest.requestId, final.sendTest.requestId);
  assert.equal(final.functionalAgentObserved, true);
});
