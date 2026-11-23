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
test('distinguishes 401 from the server allow-listed 403 causes', async () => {
  await assert.rejects(verifyBridgeCredential(respond(401), 'wrong'), /BROWSER_KEY_REJECTED_401/);
  await assert.rejects(verifyBridgeCredential(respond(403, {error:'Extension Origin denied'}), 'wrong'), /EXTENSION_ORIGIN_REJECTED_403/);
  await assert.rejects(verifyBridgeCredential(respond(403, {error:'Invalid Host'}), 'wrong'), /BRIDGE_HOST_REJECTED_403/);
  await assert.rejects(verifyBridgeCredential(respond(403, {error:'Extension ID is not pinned'}), 'wrong'), /EXTENSION_ID_NOT_PINNED_403/);
  await assert.rejects(verifyBridgeCredential(respond(403, {error:'unexpected private detail'}), 'wrong'), /BRIDGE_FORBIDDEN_403/);
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
  assert.match(handler, /BRIDGE_HOST_REJECTED_403/);
  assert.match(handler, /EXTENSION_ID_NOT_PINNED_403/);
  assert.match(js, /disconnected:'Соединение не установлено'/);
  assert.doesNotMatch(js, /disconnected:'Отключено вручную'/);
  assert.match(js, /safeErrorCode/);
  assert.match(js, /current\.error/);
});

test('persistent key automatically reconnects without granting control', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8');
  assert.match(js, /bridgeConnectionDesired === true && savedKey.value/);
  assert.match(js, /automatic && reconnectAllowed/);
  assert.match(js, /BRIDGE_NETWORK_UNREACHABLE', 'BRIDGE_TIMEOUT/);
  assert.match(js, /reconnectAllowed = false/);
  const handler = js.slice(js.indexOf('async function connectBridge'), js.indexOf("$('forgetKey').onclick"));
  assert.doesNotMatch(handler, /grants\.approve\(/);
});

test('window close does not change desired connection; disconnect is explicit', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8');
  const unload = js.slice(js.indexOf("window.addEventListener('beforeunload'"), js.indexOf('// ---------- локальная визуальная'));
  assert.doesNotMatch(unload, /storage\.local\.set/);
  const stopHandler = js.slice(js.indexOf("$('stop').onclick"), js.indexOf('async function connectBridge'));
  assert.match(stopHandler, /bridgeConnectionDesired: false/);
  const revoke = js.slice(js.indexOf("$('revoke').onclick"), js.indexOf("$('saveAdapters').onclick"));
  assert.doesNotMatch(revoke, /stop\(\)/);
});
