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
  const id = '00000000-0000-4000-8000-000000000000';
  if (tools.length === 18) {
    for (const [name, args] of [['codex_submit', { requestId: 'cutover-disabled', workspace: 'source', prompt: 'Synthetic policy rejection probe' }], ['codex_job', { jobId: id }], ['codex_cancel', { jobId: id }]]) {
      const result = await rpc('tools/call', { name, arguments: args }); assert.equal(result.isError, true); assert.match(result.content[0].text, /^CODEX_DISABLED:/);
    }
  } else assert.equal(tools.length, 15);
  console.log(JSON.stringify({ ok: true, port, count: tools.length, fullSchemas: true, browserStatus, codex: tools.length === 18 ? 'CODEX_DISABLED' : 'not_registered' }));
} catch { console.error('HEALTH_FAILED: registry, queue, transport or execution gate'); process.exitCode = 1; }
finally { if (server) await new Promise(resolve => server.close(resolve)); }

