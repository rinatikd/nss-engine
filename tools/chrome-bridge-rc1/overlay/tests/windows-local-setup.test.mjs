import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../server/bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(root, 'scripts/windows-local.mjs');
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, CHROME_BRIDGE_HOME: home, CHROME_BRIDGE_PORT: '17381' };
  delete env.CHROME_BRIDGE_EXTENSION_ID;
  delete env.CHROME_BRIDGE_CODEX_POLICY;
  return { home, env, run: (...args) => spawnSync(process.execPath, [helper, ...args], { env, encoding: 'utf8' }) };
}
const id = 'a'.repeat(32);

test('doctor never creates private state; setup pins ID, preserves tokens, and never prints credentials', t => {
  const { home, run } = sandbox(t);
  assert.equal(run('doctor').status, 1);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
  const setup = run('setup', '--extension-id', id);
  assert.equal(setup.status, 0, setup.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
  assert.equal(config.extensionId, id);
  const second = run('setup', '--extension-id', 'b'.repeat(32));
  assert.equal(second.status, 0, second.stderr);
  const updated = JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
  assert.equal(updated.agentToken, config.agentToken);
  assert.equal(updated.browserToken, config.browserToken);
  const output = setup.stdout + setup.stderr + second.stdout + second.stderr;
  assert.ok(!output.includes(config.agentToken));
  assert.ok(!output.includes(config.browserToken));
  assert.equal(run('doctor').status, 0);
});

test('invalid extension ID never creates configuration; doctor rejects missing pin and invalid port', t => {
  const { home, run, env } = sandbox(t);
  assert.equal(run('setup', '--extension-id', 'invalid').status, 1);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
  assert.equal(run('setup').status, 0);
  assert.equal(run('doctor').status, 1);
  env.CHROME_BRIDGE_PORT = '0';
  assert.equal(run('setup', '--extension-id', id).status, 1);
});

test('malformed private config never appears in diagnostics; conflicting pin is rejected', t => {
  const { home, run, env } = sandbox(t);
  const privateValue = 'PRIVATE_VALUE_MUST_NEVER_APPEAR';
  fs.writeFileSync(path.join(home, 'config.json'), '{' + privateValue);
  for (const command of ['setup', 'doctor']) {
    const result = run(command);
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes(privateValue));
  }
  fs.unlinkSync(path.join(home, 'config.json'));
  assert.equal(run('setup', '--extension-id', id).status, 0);
  env.CHROME_BRIDGE_EXTENSION_ID = 'b'.repeat(32);
  assert.equal(run('doctor').status, 1);
});

test('live doctor distinguishes disconnected Chrome from authenticated connection without emitting tokens', async t => {
  const { home, run, env } = sandbox(t);
  assert.equal(run('setup', '--extension-id', id).status, 0);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
  const server = createBridge(config, { pollHold: 30 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  env.CHROME_BRIDGE_PORT = String(server.address().port);
  const live = () => new Promise(resolve => {
    const child = spawn(process.execPath, [helper, 'doctor', '--live'], { env });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('close', code => resolve({ code, output }));
  });
  const disconnected = await live();
  assert.equal(disconnected.code, 1);
  assert.match(disconnected.output, /Chrome is disconnected/);
  const poll = await fetch(`http://127.0.0.1:${server.address().port}/bridge/poll`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.browserToken}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  await poll.json();
  const connected = await live();
  assert.equal(connected.code, 0, connected.output);
  assert.ok(!connected.output.includes(config.browserToken));
  assert.ok(!connected.output.includes(config.agentToken));
});
