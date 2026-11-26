import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../server/bridge.mjs';
import { checkDiscovery } from '../server/check-discovery.mjs';

test('current bridge through isolated proxy fixture: discovery and closed execution', { timeout: 15000 }, async t => {
  const config = { agentToken: 'isolated-agent-token', browserToken: 'isolated-browser-token' };
  const bridge = createBridge(config);
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => bridge.close(resolve)));
  const direct = `http://127.0.0.1:${bridge.address().port}/mcp`;
  const proxyServer = http.createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.headers.origin && req.headers.origin !== 'chrome-extension://isolated-test') { res.writeHead(403).end(); return; }
    if (req.headers.authorization !== `Bearer ${config.agentToken}`) { res.writeHead(401).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    try {
      const upstream = await fetch(direct, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization }, body });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      res.end(await upstream.text());
    } catch { res.writeHead(502).end(); }
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxyServer.close(resolve)));
  const proxy = `http://127.0.0.1:${proxyServer.address().port}/mcp`;
  const expected = await checkDiscovery(direct, config.agentToken);
  const actual = await checkDiscovery(proxy, config.agentToken);
  assert.equal(actual.ok, true);
  assert.equal(actual.count, 18);
  assert.deepEqual(actual, expected);
  const call = async (url, name, args, token = config.agentToken, extra = {}) => fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const jobId = '00000000-0000-4000-8000-000000000000';
  for (const [name, args] of [['codex_submit', { requestId: 'isolated', workspace: 'source', prompt: 'synthetic' }], ['codex_job', { jobId }], ['codex_cancel', { jobId }]]) {
    const body = await (await call(proxy, name, args)).json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /^CODEX_DISABLED:/);
  }
  assert.equal((await call(direct, 'codex_job', { jobId }, 'wrong')).status, 401);
  assert.equal((await call(proxy, 'codex_job', { jobId }, config.agentToken, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(proxy.replace('/mcp', '/bridge/poll'), { method: 'POST' })).status, 404);
});

test('deployment check detects stale discovery without calling tools', async t => {
  const server = http.createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    assert.equal(JSON.parse(input).method, 'tools/list');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: { tools: [{ name: 'browser_status' }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await checkDiscovery(`http://127.0.0.1:${server.address().port}/mcp`, 'synthetic');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['codex_submit', 'codex_job', 'codex_cancel']);
});

