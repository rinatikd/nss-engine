import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRpcEnvelope } from '../server/rpc-envelope.mjs';

for (const id of [0, 1, -1, 0.5, '', 'request-1']) {
  test(`RPC envelope accepts request id ${JSON.stringify(id)}`, () => {
    assert.deepEqual(validateRpcEnvelope({ jsonrpc: '2.0', id, method: 'ping', params: {} }), { ok: true, notification: false, id });
  });
}

test('RPC envelope marks a valid notification only after validation', () => {
  assert.deepEqual(validateRpcEnvelope({ jsonrpc: '2.0', method: 'notifications/initialized' }), { ok: true, notification: true });
});

for (const [label, message] of [
  ['null envelope', null], ['array envelope', []], ['primitive envelope', 'ping'],
  ['missing protocol', { method: 'ping' }], ['wrong protocol', { jsonrpc: '1.0', method: 'ping' }],
  ['missing method', { jsonrpc: '2.0' }], ['non-string method', { jsonrpc: '2.0', method: 1 }],
  ...[null, true, {}, [], NaN, Infinity, -Infinity, undefined].map(id => ['invalid id ' + String(id), { jsonrpc: '2.0', id, method: 'ping' }]),
  ...[null, [], 'bad', 1, true, undefined].map(params => ['invalid params ' + String(params), { jsonrpc: '2.0', method: 'initialize', params }]),
]) {
  test(`RPC envelope rejects ${label}`, () => {
    assert.deepEqual(validateRpcEnvelope(message), { ok: false, response: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } });
  });
}

test('RPC envelope validation does not mutate the request', () => {
  const params = Object.freeze({ protocolVersion: '2025-06-18' });
  const message = Object.freeze({ jsonrpc: '2.0', id: 'init', method: 'initialize', params });
  assert.equal(validateRpcEnvelope(message).ok, true);
  assert.equal(message.params, params);
});
