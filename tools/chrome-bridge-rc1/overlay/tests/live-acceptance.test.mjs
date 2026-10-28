// Local HTTP fixtures exercise verifier logic, not Chrome or live AI websites.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyLive, REQUIRED_TOOLS } from '../scripts/verify-live.mjs';

const config = { agentToken: 'a'.repeat(64), browserToken: 'b'.repeat(64) };
const sensitive = 'PRIVATE-PAGE-CONTENT https://private.example/thread';
async function fixture(t, custom = () => undefined) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/mcp');
    assert.equal(req.headers.authorization, `Bearer ${config.agentToken}`);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw); calls.push(message);
    const name = message.params?.name;
    let value = custom(message);
    if (value === undefined) {
      if (message.method === 'initialize') value = { serverInfo: { name: 'chrome-bridge' }, capabilities: { tools: {} } };
      else if (message.method === 'tools/list') value = { tools: REQUIRED_TOOLS.map(name => ({ name })) };
      else if (name === 'browser_status') value = { connected: true };
      else if (name === 'agent_list') value = { bound: [{ name: 'test', alive: true }], chatTabs: [{ url: sensitive, title: sensitive }] };
      else if (name === 'agent_selftest') value = Object.fromEntries(['composer', 'send', 'stop', 'reply'].map(key => [key, { matched: key === 'stop' ? 0 : 1, visible: key === 'stop' ? 0 : 1, selector: sensitive }]));
      else value = { done: false };
    }
    const result = message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify(value) }] } : value;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { calls, port: server.address().port };
}

test('default acceptance is read-only and separates readable state from agent testing', async t => {
  const { calls, port } = await fixture(t);
  const report = await verifyLive({ config, port });
  assert.equal(report.passed, true);
  assert.equal(report.readableStateVerified, true);
  assert.equal(report.functionalAgentObserved, false);
  assert.equal(report.fullyTestedAgent, false);
  assert.deepEqual(calls.map(item => item.params?.name || item.method), ['initialize', 'tools/list', 'browser_status', 'agent_list']);
  assert.ok(!JSON.stringify(report).includes(sensitive));
  assert.ok(!JSON.stringify(report).includes(config.agentToken));
});

test('chosen bound agent exposes numeric selector counts only', async t => {
  const { port } = await fixture(t);
  const report = await verifyLive({ config, port, agent: 'test' });
  assert.equal(report.passed, true);
  assert.deepEqual(report.selectors.composer, { matched: 1, visible: 1 });
  assert.ok(!JSON.stringify(report).includes(sensitive));
});

test('explicit test sends once, persists ID before dispatch, waits without resend, and keeps unverified attribution', async t => {
  let nonce, persisted;
  const { calls, port } = await fixture(t, message => {
    if (message.params?.name === 'agent_ask') {
      assert.equal(persisted, message.params.arguments.requestId);
      nonce = message.params.arguments.text.split(' ').at(-1);
      return { done: false, sent: true, deliveryStatus: 'UNKNOWN' };
    }
    if (message.params?.name === 'agent_wait') return { done: true, reply: `${sensitive} ${nonce}`, deliveryStatus: 'CONFIRMED', replyAttribution: 'VERIFIED' };
  });
  const report = await verifyLive({ config, port, agent: 'test', sendTest: true, beforeSend: async report => { persisted = report.sendTest.requestId; } });
  assert.equal(report.passed, true);
  assert.equal(report.functionalAgentObserved, true);
  assert.equal(report.sendTest.deliveryStatus, 'UNKNOWN');
  assert.equal(report.sendTest.replyAttribution, 'UNVERIFIED');
  assert.equal(calls.filter(item => item.params?.name === 'agent_ask').length, 1);
  assert.equal(calls.filter(item => item.params?.name === 'agent_send').length, 0);
  const output = JSON.stringify(report);
  assert.ok(!output.includes(nonce));
  assert.ok(!output.includes(sensitive));
});

test('uncertain send never resends or claims a functional observation', async t => {
  const { calls, port } = await fixture(t, message => message.params?.name === 'agent_ask' ? { done: false, sent: false, deliveryStatus: 'UNKNOWN' } : undefined);
  const report = await verifyLive({ config, port, agent: 'test', sendTest: true });
  assert.equal(report.passed, false);
  assert.equal(report.functionalAgentObserved, false);
  assert.equal(report.sendTest.attempted, true);
  assert.equal(calls.filter(item => item.params?.name === 'agent_ask').length, 1);
  assert.equal(calls.filter(item => item.params?.name === 'agent_wait').length, 0);
});

test('report persistence failure prevents the only sending call', async t => {
  const { calls, port } = await fixture(t);
  const report = await verifyLive({ config, port, agent: 'test', sendTest: true, beforeSend: async () => { throw Error(sensitive); } });
  assert.equal(report.passed, false);
  assert.equal(calls.filter(item => item.params?.name === 'agent_ask').length, 0);
  assert.ok(!JSON.stringify(report).includes(sensitive));
});

test('non-completing observation stops after a finite number of waits and never resends', async t => {
  const { calls, port } = await fixture(t, message => message.params?.name === 'agent_ask' ? { done: false, sent: true } : undefined);
  const report = await verifyLive({ config, port, agent: 'test', sendTest: true });
  assert.equal(report.passed, false);
  assert.equal(report.failureCode, 'REPLY_NOT_OBSERVED_BEFORE_TIMEOUT');
  assert.equal(calls.filter(item => item.params?.name === 'agent_ask').length, 1);
  assert.equal(calls.filter(item => item.params?.name === 'agent_wait').length, 30);
});

test('missing tools and disconnected Chrome fail without any send', async t => {
  for (const mode of ['tools', 'chrome']) {
    const { calls, port } = await fixture(t, message => mode === 'tools' && message.method === 'tools/list' ? { tools: [] }
      : mode === 'chrome' && message.params?.name === 'browser_status' ? { connected: false } : undefined);
    const report = await verifyLive({ config, port, agent: 'test', sendTest: true });
    assert.equal(report.passed, false);
    assert.equal(report.sendTest.attempted, false);
    assert.equal(calls.filter(item => item.params?.name === 'agent_ask').length, 0);
  }
});

test('CLI persists sanitized failure report without creating private config', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-acceptance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'report.json');
  const configDir = path.join(dir, 'missing-private-home');
  const helper = fileURLToPath(new URL('../scripts/verify-live.mjs', import.meta.url));
  const child = spawn(process.execPath, [helper, '--report', output], { env: { ...process.env, CHROME_BRIDGE_HOME: configDir } });
  let consoleOutput = ''; child.stdout.on('data', chunk => consoleOutput += chunk); child.stderr.on('data', chunk => consoleOutput += chunk);
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 1);
  assert.equal(fs.existsSync(configDir), false);
  assert.equal(JSON.parse(fs.readFileSync(output)).failureCode, 'PRIVATE_CONFIG_INVALID');
  assert.ok(!consoleOutput.includes(config.agentToken));
});

test('one-command CLI persists pre-send ID and final sanitized observation using a local fixture', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-acceptance-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const output = path.join(dir, 'observation.json');
  let nonce;
  const { calls, port } = await fixture(t, message => {
    if (message.params?.name !== 'agent_ask') return undefined;
    const persisted = JSON.parse(fs.readFileSync(output));
    assert.equal(persisted.sendTest.requestId, message.params.arguments.requestId);
    assert.equal(persisted.sendTest.attempted, true);
    nonce = message.params.arguments.text.split(' ').at(-1);
    return { done: true, reply: nonce };
  });
  const helper = fileURLToPath(new URL('../scripts/verify-live.mjs', import.meta.url));
  const child = spawn(process.execPath, [helper, '--report', output, '--agent', 'test', '--send-test'], {
    env: { ...process.env, CHROME_BRIDGE_HOME: dir, CHROME_BRIDGE_PORT: String(port) },
  });
  let consoleOutput = ''; child.stdout.on('data', chunk => consoleOutput += chunk); child.stderr.on('data', chunk => consoleOutput += chunk);
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, consoleOutput);
  const report = JSON.parse(fs.readFileSync(output));
  assert.equal(report.functionalAgentObserved, true);
  assert.equal(report.sendTest.deliveryStatus, 'UNKNOWN');
  assert.equal(calls.filter(item => item.params?.name === 'agent_ask').length, 1);
  assert.ok(!(consoleOutput + JSON.stringify(report)).includes(nonce));
  assert.ok(!(consoleOutput + JSON.stringify(report)).includes(config.agentToken));
});
