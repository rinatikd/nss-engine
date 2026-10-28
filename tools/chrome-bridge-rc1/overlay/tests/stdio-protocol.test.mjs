import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function fixture(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stdio-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agentToken: 'a'.repeat(64), browserToken: 'b'.repeat(64) }));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, port: server.address().port };
}

function proxy(t, f, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/stdio.mjs'], { env: { ...process.env, CHROME_BRIDGE_HOME: f.dir, CHROME_BRIDGE_PORT: String(f.port) }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const output = [], errors = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() }));
    child.stdin.end(input);
  });
}

const response = (res, body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

test('stdio flushes a large response before exiting on input EOF', { timeout: 5000 }, async t => {
  const expected = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'x'.repeat(2_000_000) }] } };
  const f = await fixture(t, (_req, res) => response(res, expected));
  const result = await proxy(t, f, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
});

test('stdio returns a JSON-RPC parse error and continues to the next request', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => response(res, { jsonrpc: '2.0', id: 2, result: {} }));
  const result = await proxy(t, f, '{invalid\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  const lines = result.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(lines.some(msg => msg.id === null && msg.error?.code === -32700));
  assert.ok(lines.some(msg => msg.id === 2 && msg.result));
});

test('stdio never emits a response to a notification', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => response(res, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } }));
  const result = await proxy(t, f, '{"jsonrpc":"2.0","method":"some/notification"}\n');
  assert.equal(result.stdout, '');
});

test('stdio does not follow redirects carrying the agent credential', { timeout: 5000 }, async t => {
  let redirected = false;
  const target = await fixture(t, (_req, res) => { redirected = true; response(res, { jsonrpc: '2.0', id: 1, result: {} }); });
  const f = await fixture(t, (_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${target.port}/mcp` }); res.end(); });
  const result = await proxy(t, f, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  assert.equal(redirected, false);
  assert.equal(JSON.parse(result.stdout).error.code, -32603);
});

test('stdio processes a later request while an earlier one is waiting', { timeout: 5000 }, async t => {
  let waiting;
  const f = await fixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw);
    if (msg.id === 1) { waiting = res; return; }
    response(res, { jsonrpc: '2.0', id: 2, result: {} });
    response(waiting, { jsonrpc: '2.0', id: 1, result: {} });
  });
  const result = await proxy(t, f, '{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse).map(msg => msg.id).sort(), [1, 2]);
});

test('stdio reports a bounded transport timeout without retrying', { timeout: 5000 }, async t => {
  const { PassThrough } = await import('node:stream');
  const { runStdio } = await import('../server/stdio.mjs');
  let calls = 0;
  const f = await fixture(t, () => { calls++; });
  const input = new PassThrough(), output = new PassThrough();
  let raw = ''; output.on('data', chunk => { raw += chunk; });
  const complete = runStdio({ input, output, config: { agentToken: 'synthetic-agent' }, port: f.port, timeoutMs: 100 });
  input.end('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
  await complete;
  assert.equal(calls, 1);
  assert.equal(JSON.parse(raw).error.code, -32603);
  assert.match(JSON.parse(raw).error.message, /may have completed/);
});

test('stdio reserializes pretty HTTP JSON into a single protocol line', { timeout: 5000 }, async t => {
  const expected = { jsonrpc: '2.0', id: 'ping', result: {} };
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify(expected, null, 2)));
  const result = await proxy(t, f, '{"jsonrpc":"2.0","id":"ping","method":"ping"}\n');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
});

test('stdio rejects a mismatched upstream response id', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => response(res, { jsonrpc: '2.0', id: 7, result: {} }));
  const result = await proxy(t, f, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const msg = JSON.parse(result.stdout);
  assert.equal(msg.id, 1);
  assert.equal(msg.error.code, -32603);
});

for (const invalid of ['null', '[]', '{"id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":false,"method":"ping"}', '{"jsonrpc":"2.0","id":1,"method":"ping","params":null}', '{"jsonrpc":"2.0","id":null,"method":"ping"}', '{"jsonrpc":"2.0","method":"initialize","params":[]}']) {
  test(`stdio rejects invalid request ${invalid}`, { timeout: 5000 }, async t => {
    let calls = 0;
    const f = await fixture(t, (_req, res) => { calls++; response(res, {}); });
    const result = await proxy(t, f, invalid + '\n');
    const msg = JSON.parse(result.stdout);
    assert.equal(msg.id, null);
    assert.equal(msg.error.code, -32600);
    assert.equal(calls, 0);
  });
}
