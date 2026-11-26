import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, target, countText] = process.argv.slice(2);
const expectedCount = Number(countText);
const configFile = path.join(process.env.CHROME_BRIDGE_HOME || path.join(process.env.USERPROFILE, '.chrome-bridge'), 'config.json');
let server;
try {
  let base, token;
  if (mode === 'isolated') {
    const { createBridge } = await import(pathToFileURL(path.resolve(target, 'server/bridge.mjs')));
    token = 'cutover-synthetic-agent';
    server = createBridge({ agentToken: token, browserToken: 'cutover-synthetic-browser' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  } else if (mode === 'live') {
    if (!['17381', '17382'].includes(target)) throw Error('Invalid production port');
    token = JSON.parse(fs.readFileSync(configFile, 'utf8')).agentToken;
    base = `http://127.0.0.1:${target}`;
  } else throw Error('Invalid mode');
  const rpc = async (method, params) => {
    const r = await fetch(base + '/mcp', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (!body.result || body.error) throw Error('Invalid RPC result');
    return body.result;
  };
  const names = (await rpc('tools/list')).tools.map(t => t.name).sort();
  const current = (await import('../server/tools.mjs')).tools.map(t => t.name).sort();
  const expected = expectedCount === 18 ? current : current.filter(n => !n.startsWith('codex_'));
  if (![15, 18].includes(expectedCount) || JSON.stringify(names) !== JSON.stringify(expected)) throw Error(`Registry mismatch: expected ${expectedCount}, got ${names.length}`);
  const status = await rpc('tools/call', { name: 'browser_status', arguments: {} });
  if (status.isError) throw Error('browser_status failed');
  if (expectedCount === 18) {
    const jobId = '00000000-0000-4000-8000-000000000000';
    for (const [name, args] of [['codex_submit', { requestId: 'cutover-disabled-probe', workspace: 'source', prompt: 'Synthetic disabled-policy probe. Do not execute.' }], ['codex_job', { jobId }], ['codex_cancel', { jobId }]]) {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result.isError !== true || !result.content?.some(c => /^CODEX_DISABLED:/.test(c.text || ''))) throw Error(`${name} execution gate mismatch`);
    }
  }
  console.log(JSON.stringify({ mode, expectedCount, names, browserStatus: JSON.parse(status.content[0].text), ok: true }));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
}

