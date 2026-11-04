import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBridgeCredential } from '../extension/connection-check.js';

const respond = (status, payload = { epoch: 'instance-123', command: null }) =>
  async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.body, '{}');
    assert.match(options.headers.Authorization, /^Bearer /);
    return { status, ok: status === 200, json: async () => payload };
  };
test('accepts authenticated bridge handshake without writing credentials', async () => {
  const r = await verifyBridgeCredential(respond(200), '  sample-key  ');
  assert.equal(r.epoch, 'instance-123');
});
test('rejects empty credential before network call', async () => {
  await assert.rejects(verifyBridgeCredential(() => { throw Error('unexpected fetch'); }, ' '), /KEY_EMPTY/);
});
test('distinguishes rejected key from extension origin', async () => {
  await assert.rejects(verifyBridgeCredential(respond(401), 'wrong'), /BROWSER_KEY_REJECTED_401/);
  await assert.rejects(verifyBridgeCredential(respond(403), 'wrong'), /EXTENSION_ORIGIN_REJECTED_403/);
});
test('rejects unexpected server replies and network failures', async () => {
  await assert.rejects(verifyBridgeCredential(respond(200, { command: null }), 'x'), /BRIDGE_INVALID_HANDSHAKE/);
  await assert.rejects(verifyBridgeCredential(async () => { throw Error('ECONNREFUSED'); }, 'x'), /BRIDGE_NETWORK_UNREACHABLE/);
});

test('HTML has readable labels and the controller verifies before persisting', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../extension/control.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8');
  assert.match(html, /Подключение/);
  assert.match(html, /Удалить сохранённый ключ/);
  assert.doesNotMatch(html, /РџРѕ|РњРѕ|РєР»/);
  const handler = js.slice(js.indexOf('async function connectBridge'), js.indexOf("$('forgetKey').onclick"));
  assert.ok(handler.indexOf('verifyBridgeCredential') < handler.indexOf('saveBrowserKey'));
  assert.match(handler, /BROWSER_KEY_REJECTED_401/);
  assert.match(handler, /EXTENSION_ORIGIN_REJECTED_403/);
});

test('persistent key automatically reconnects without granting control', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8');
  assert.match(js, /if \(savedKey\.persistent && savedKey\.value\) void connectBridge\(\{ automatic: true \}\)/);
  assert.match(js, /automatic && reconnectAllowed/);
  assert.match(js, /BRIDGE_NETWORK_UNREACHABLE', 'BRIDGE_TIMEOUT/);
  assert.match(js, /reconnectAllowed = false/);
  const handler = js.slice(js.indexOf('async function connectBridge'), js.indexOf("$('forgetKey').onclick"));
  assert.doesNotMatch(handler, /grants\.approve\(/);
});
