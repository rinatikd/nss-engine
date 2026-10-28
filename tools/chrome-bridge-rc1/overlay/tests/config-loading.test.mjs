import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/bridge.mjs';

const valid = { agentToken: 'a'.repeat(64), browserToken: 'b'.repeat(64) };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'config.json') };
}

function rejectsInvalid(dir) {
  assert.throws(() => loadConfig(dir), error => {
    assert.equal(error.message, 'CONFIG_INVALID');
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('loadConfig preserves existing valid private tokens and file bytes', t => {
  const { dir, file } = fixture(t);
  const raw = JSON.stringify({ ...valid, extensionId: 'a'.repeat(32) }, null, 2) + '\n';
  fs.writeFileSync(file, raw);
  assert.deepEqual(loadConfig(dir), { ...valid, extensionId: 'a'.repeat(32) });
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('loadConfig accepts an existing valid config before extension pinning', t => {
  const { dir, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify(valid));
  assert.deepEqual(loadConfig(dir), valid);
});

test('loadConfig creates lowercase 256-bit hex tokens for a fresh config', t => {
  const { dir, file } = fixture(t);
  const config = loadConfig(dir);
  assert.match(config.agentToken, /^[a-f0-9]{64}$/);
  assert.match(config.browserToken, /^[a-f0-9]{64}$/);
  assert.notEqual(config.agentToken, config.browserToken);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), config);
});

test('loadConfig sanitizes malformed private JSON instead of exposing a token fragment', t => {
  const { dir, file } = fixture(t);
  const fragment = 'SYNTH';
  const raw = `{"${fragment}": invalid}`;
  fs.writeFileSync(file, raw);
  assert.throws(() => loadConfig(dir), error => {
    assert.equal(String(error).includes(fragment), false);
    assert.equal(error.message, 'CONFIG_INVALID');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('loadConfig sanitizes private configuration filesystem errors', t => {
  const { dir, file } = fixture(t);
  fs.mkdirSync(file);
  assert.throws(() => loadConfig(dir), error => {
    assert.equal(error.message, 'CONFIG_UNREADABLE');
    assert.equal(String(error).includes(dir), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

for (const name of ['agentToken', 'browserToken']) {
  for (const [label, value] of [['missing', undefined], ['null', null], ['number', 42], ['object', {}], ['empty', ''], ['short', 'a'.repeat(63)], ['long', 'a'.repeat(65)], ['uppercase', 'A'.repeat(64)], ['non-hex', 'g'.repeat(64)], ['newline', 'a'.repeat(64) + '\n']]) {
    test(`loadConfig rejects ${label} ${name} without replacing the file`, t => {
      const { dir, file } = fixture(t);
      const raw = JSON.stringify({ ...valid, [name]: value });
      fs.writeFileSync(file, raw);
      rejectsInvalid(dir);
      assert.equal(fs.readFileSync(file, 'utf8'), raw);
    });
  }
}

for (const [label, value] of [['null', null], ['array', []], ['primitive', 'private-config'], ['missing tokens', {}]]) {
  test(`loadConfig rejects ${label} root config`, t => {
    const { dir, file } = fixture(t);
    fs.writeFileSync(file, JSON.stringify(value));
    rejectsInvalid(dir);
  });
}

for (const value of [null, '', 'a'.repeat(31), 'a'.repeat(33), 'a'.repeat(32) + '\n', 'q'.repeat(32), 'A'.repeat(32), 42, {}]) {
  test(`loadConfig rejects invalid present extensionId ${JSON.stringify(value)}`, t => {
    const { dir, file } = fixture(t);
    fs.writeFileSync(file, JSON.stringify({ ...valid, extensionId: value }));
    rejectsInvalid(dir);
  });
}
