import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpAgentAdapter } from '../src/adapters/http-agent.mjs';
import { NotDispatched } from '../src/dispatcher.mjs';

async function serverWith(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/invoke`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('HTTP adapter sends task and requires an attested completion', async t => {
  let request;
  const s = await serverWith(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); request = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accepted: true, dispatched: true, status: 'completed', invocationId: 'claude-run-123', text: 'Review complete.' }));
  }); t.after(s.close);
  const adapter = new HttpAgentAdapter({ name: 'claude', url: s.url });
  const result = await adapter.send({ id: 'task-1', contextId: 'ctx-1', sender: 'chatgpt', recipient: 'claude', parentId: null, text: 'Review this' });
  assert.equal(request.taskId, 'task-1'); assert.equal(request.text, 'Review this');
  assert.deepEqual(result, { kind: 'response', text: 'Review complete.', invocationId: 'claude-run-123' });
});

test('HTTP adapter only retries when bridge explicitly proves pre-dispatch rejection', async t => {
  const s = await serverWith((_req, res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accepted: false, dispatched: false })); }); t.after(s.close);
  const adapter = new HttpAgentAdapter({ name: 'claude', url: s.url });
  await assert.rejects(adapter.send({ id: 'task-2', contextId: 'ctx-1', sender: 'chatgpt', recipient: 'claude', text: 'Review' }), e => e instanceof NotDispatched);
});

test('HTTP adapter rejects remote plaintext endpoints', () => {
  assert.throws(() => new HttpAgentAdapter({ name: 'claude', url: 'http://example.com/invoke' }), /REMOTE_ADAPTER_REQUIRES_HTTPS/);
});
