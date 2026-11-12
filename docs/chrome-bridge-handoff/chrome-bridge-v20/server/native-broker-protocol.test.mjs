import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeBrokerFrame, decodeBrokerFrame, createBrokerFrameDecoder } from './native-broker-protocol.mjs';

const id = 'req_20261112_1';
const ready = { type: 'ready', requestId: id, pid: 1234, contained: true };
const terminated = { type: 'terminated', requestId: id, verified: true, activeProcesses: 0 };

test('ready frame survives chunked UTF-8 transport', () => {
  const bytes = Buffer.from(encodeBrokerFrame(ready));
  const d = createBrokerFrameDecoder(id);
  assert.equal(d.push(bytes.subarray(0, 4)), null);
  assert.deepEqual(d.push(bytes.subarray(4)), ready);
  assert.doesNotThrow(() => d.end());
});
test('verified termination response parses', () => {
  assert.deepEqual(decodeBrokerFrame(JSON.stringify(terminated), id), terminated);
});
test('requestId mismatch is rejected', () => {
  assert.throws(() => decodeBrokerFrame(JSON.stringify(ready), 'another_id'), /IPC_REQUEST_MISMATCH/);
});
test('false OS proof is rejected', () => {
  assert.throws(() => decodeBrokerFrame(JSON.stringify({ ...terminated, activeProcesses: 1 }), id), /IPC_INVALID_TERMINATED/);
  assert.throws(() => decodeBrokerFrame(JSON.stringify({ ...ready, contained: false }), id), /IPC_INVALID_READY/);
});
test('unknown fields and unknown types are rejected', () => {
  assert.throws(() => decodeBrokerFrame(JSON.stringify({ ...ready, extra: 'x' }), id), /IPC_INVALID_READY/);
  assert.throws(() => decodeBrokerFrame(JSON.stringify({ type: 'reset', requestId: id }), id), /IPC_UNEXPECTED_TYPE/);
});
test('truncated and duplicate frames are rejected', () => {
  const d = createBrokerFrameDecoder(id);
  d.push(Buffer.from('{"type":"ready"'));
  assert.throws(() => d.end(), /IPC_INCOMPLETE_FRAME/);
  const d2 = createBrokerFrameDecoder(id);
  assert.throws(() => d2.push(Buffer.from(encodeBrokerFrame(ready) + encodeBrokerFrame(ready))), /IPC_TRAILING_DATA/);
});
test('oversized, malformed and invalid UTF-8 frames are rejected', () => {
  assert.throws(() => decodeBrokerFrame('x'.repeat(65537), id), /IPC_INVALID_FRAME/);
  assert.throws(() => decodeBrokerFrame('{broken}', id), /IPC_INVALID_JSON/);
  const d = createBrokerFrameDecoder(id);
  assert.throws(() => d.push(Buffer.from([0xff, 0x0a])), /encoded data was not valid|UTF-8|utf-8/i);
});
test('newline injection and invalid identifiers are rejected', () => {
  assert.throws(() => decodeBrokerFrame(JSON.stringify(ready) + '\n', id), /IPC_INVALID_FRAME/);
  assert.throws(() => createBrokerFrameDecoder('bad id'), /IPC_INVALID_REQUEST_ID/);
});

test('native Windows CRLF frame is accepted, embedded CR remains denied', () => {
  const bytes = Buffer.from(JSON.stringify(ready) + '\r\n');
  const d = createBrokerFrameDecoder(id);
  assert.equal(d.push(bytes.subarray(0, bytes.length - 1)), null);
  assert.deepEqual(d.push(bytes.subarray(bytes.length - 1)), ready);
  d.end();
  const invalid = createBrokerFrameDecoder(id);
  assert.throws(() => invalid.push(Buffer.from('{"type":"rea\rdy"}\r\n')), /IPC_INVALID_FRAME/);
});
