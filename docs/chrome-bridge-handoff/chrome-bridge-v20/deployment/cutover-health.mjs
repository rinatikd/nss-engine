import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
let server;
try {
  let port = job.port, config;
  if (job.mode === 'isolated') {
    config = { agentToken: 'rehearsal-health-agent', browserToken: 'rehearsal-health-browser' };
    const { createBridge } = await import(pathToFileURL(path.join(job.source, 'server/bridge.mjs')));
    server = createBridge(config);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
  } else config = JSON.parse(fs.readFileSync(path.join(job.state, 'config.json'), 'utf8'));
  const rpc = async (method, params) => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(r.status, 200);
    const response = await r.json(); assert.ok(response.result && !response.error); return response.result;
  };
  const tools = (await rpc('tools/list')).tools;
  const expected = JSON.parse(fs.readFileSync(job.expected, 'utf8').replace(/^\uFEFF/, '')).result.tools;
  assert.deepEqual(tools, expected);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cutover-health', version: '2' } });
  assert.equal(init.serverInfo.name, 'chrome-bridge');
  const status = await rpc('tools/call', { name: 'browser_status', arguments: {} }); assert.notEqual(status.isError, true);
  const browserStatus = JSON.parse(status.content[0].text); assert.equal(browserStatus.queued, 0, 'Pending requests');
  // The MCP registry is versioned and may grow as capabilities are added.
  // Exact schema equality above is the contract; a fixed tool-count gate would
  // reject legitimate additions such as Session Authorization and ProviderTransport.
  console.log(JSON.stringify({ ok: true, port, count: tools.length, fullSchemas: true, browserStatus }));
} catch (error) {
  // Preserve actionable diagnostics from disposable CI/Lab probes without dumping request headers or credentials.
  const detail = String(error?.stack || error?.message || error || 'unknown error').slice(0, 6000);
  console.error('HEALTH_FAILED:', detail);
  process.exitCode = 1;
}
finally { if (server) await new Promise(resolve => server.close(resolve)); }

