import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { runStdio } from '../server/stdio.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

async function exchange(port, messages, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  let raw = '', errors = '';
  output.on('data', chunk => { raw += chunk; });
  diagnostics.on('data', chunk => { errors += chunk; });
  const complete = runStdio({ input, output, diagnostics, config: { agentToken: 'synthetic-only' }, port, ...options });
  for (const message of messages) input.write(message);
  input.end();
  await complete;
  return { messages: raw.trim() ? raw.trim().split('\n').map(JSON.parse) : [], errors };
}

const request = (id = 1, method = 'ping', params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

for (const error of [null, 'failure', [], {}, { code: 'bad', message: 'bad' }, { code: 1.5, message: 'bad' }, { code: -1, message: 42 }]) {
  test(`stdio rejects malformed upstream error ${JSON.stringify(error)}`, { timeout: 5000 }, async t => {
    const port = await fixture(t, (_req, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error })));
    const result = await exchange(port, [request()]);
    assert.equal(result.messages[0].error?.code, -32603);
    assert.match(result.messages[0].error.message, /may have completed/);
  });
}

test('stdio forwards a valid upstream error including optional data', { timeout: 5000 }, async t => {
  const expected = { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Unavailable', data: { retry: false } } };
  const port = await fixture(t, (_req, res) => res.end(JSON.stringify(expected)));
  assert.deepEqual((await exchange(port, [request()])).messages, [expected]);
});

test('stdio handles split multibyte large JSON, CRLF and final EOF frame', { timeout: 5000 }, async t => {
  const payload = '中😀\n'.repeat(100_000);
  let received;
  const port = await fixture(t, async (req, res) => {
    req.setEncoding('utf8');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    received = message.params.payload;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: true }));
  });
  const bytes = Buffer.from(request(1, 'ping', { payload }).trimEnd());
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  const result = await exchange(port, [Buffer.from(' \r\n'), bytes.subarray(0, split), bytes.subarray(split)]);
  assert.equal(received === payload, true, 'large multibyte request survives stream chunk boundaries');
  assert.deepEqual(result.messages, [{ jsonrpc: '2.0', id: 1, result: true }]);
});

test('stdio waits for slow output callbacks across concurrent replies and EOF', { timeout: 5000 }, async t => {
  const port = await fixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(raw).id, result: 'x'.repeat(200_000) }));
  });
  const input = new PassThrough();
  const records = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    setTimeout(() => { records.push(JSON.parse(chunk.toString())); callback(); }, 10);
  } });
  const complete = runStdio({ input, output, config: { agentToken: 'synthetic-only' }, port });
  input.end(request(1) + request(2));
  await complete;
  assert.deepEqual(records.map(record => record.id).sort(), [1, 2]);
  assert.ok(records.every(record => record.result.length === 200_000));
});

for (const delayedDestroy of [false, true]) test(`stdio handles a broken output pipe with ${delayedDestroy ? 'asynchronous' : 'synchronous'} teardown`, { timeout: 5000 }, async () => {
  const script = `
    import { PassThrough, Writable } from 'node:stream';
    import { runStdio } from ${JSON.stringify(new URL('../server/stdio.mjs', import.meta.url).href)};
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, done) { done(Object.assign(new Error('closed pipe'), { code: 'EPIPE' })); },
      destroy(error, done) { ${delayedDestroy ? 'setImmediate(() => done(error))' : 'done(error)'}; }
    });
    const closed = new Promise(resolve => output.once('close', resolve));
    const complete = runStdio({ input, output, config: { agentToken: 'synthetic-only' } });
    input.end('invalid\\n');
    await complete;
    await closed;
    if (output.listenerCount('error') !== 0 || output.listenerCount('close') !== 0) throw Error('stdio output listener leaked');
    const secondInput = new PassThrough();
    const secondComplete = runStdio({ input: secondInput, output, config: { agentToken: 'synthetic-only' } });
    secondInput.end('invalid\\n');
    await secondComplete;
    if (output.listenerCount('error') !== 0 || output.listenerCount('close') !== 0) throw Error('repeated stdio output listener leaked');
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Bridge stdio output failed/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});

test('stdio releases output listeners after repeated successful sessions', { timeout: 5000 }, async () => {
  const output = new PassThrough();
  output.resume();
  for (let i = 0; i < 3; i++) {
    const input = new PassThrough();
    const complete = runStdio({ input, output, config: { agentToken: 'synthetic-only' } });
    input.end('invalid\n');
    await complete;
    assert.equal(output.listenerCount('error'), 0);
    assert.equal(output.listenerCount('close'), 0);
  }
});

test('stdio aborts a stalled response body once and reports uncertainty', { timeout: 5000 }, async t => {
  let calls = 0;
  const port = await fixture(t, (_req, res) => { calls++; res.writeHead(200); res.write('{'); });
  const result = await exchange(port, [request(1, 'tools/call')], { timeoutMs: 100 });
  assert.equal(calls, 1);
  assert.equal(result.messages[0].error.code, -32603);
  assert.match(result.messages[0].error.message, /may have completed/);
});

test('stdio forwards cancellation while a request waits without replying to the notification', { timeout: 5000 }, async t => {
  let waiting, cancelParams;
  let received;
  const requestReceived = new Promise(resolve => { received = resolve; });
  const port = await fixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.id === 'pending') { waiting = res; received(); return; }
    if (message.method === 'notifications/cancelled') {
      cancelParams = message.params;
      res.writeHead(202); res.end();
      waiting.end(JSON.stringify({ jsonrpc: '2.0', id: 'pending', error: { code: -32800, message: 'Cancelled' } }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  });
  const input = new PassThrough(), output = new PassThrough();
  let raw = '';
  output.on('data', chunk => { raw += chunk; });
  const complete = runStdio({ input, output, config: { agentToken: 'synthetic-only' }, port });
  input.write(request('pending', 'tools/call'));
  // Use the server's observation rather than a timing assumption to send cancellation.
  await requestReceived;
  input.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'pending', reason: 'selftest' } }) + '\n' + request('ping'));
  await complete;
  assert.deepEqual(cancelParams, { requestId: 'pending', reason: 'selftest' });
  const replies = raw.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 2);
  assert.equal(replies.find(reply => reply.id === 'pending').error.code, -32800);
  assert.deepEqual(replies.find(reply => reply.id === 'ping').result, {});
});
