import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkDiscovery } from '../server/check-discovery.mjs';

for (const [label, payload] of [
  ['missing envelope', { result: { tools: [] } }],
  ['wrong response id', { jsonrpc: '2.0', id: 2, result: { tools: [] } }],
  ['wrong protocol', { jsonrpc: '1.0', id: 1, result: { tools: [] } }],
  ['mixed result and error', { jsonrpc: '2.0', id: 1, result: { tools: [] }, error: { code: -32603, message: 'failed' } }],
  ['invalid tool name', { jsonrpc: '2.0', id: 1, result: { tools: [null] } }],
  ['duplicate tools', { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'codex_job' }, { name: 'codex_job' }] } }],
]) {
  test(`discovery rejects ${label}`, async t => {
    const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    await assert.rejects(checkDiscovery(`http://127.0.0.1:${server.address().port}/mcp`, 'synthetic-agent'), /Invalid tools\/list response/);
  });
}
