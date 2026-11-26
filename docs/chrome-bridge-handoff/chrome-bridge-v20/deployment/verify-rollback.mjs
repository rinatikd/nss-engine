// Isolated compatibility evidence. Production requests are metadata only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'integration-reports/rollback-recovery');
const candidate = path.join(root, 'rollback-candidates/v020-cors-recovered');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-verify-'));
const children = [];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2));
const productionState = path.join(os.homedir(), '.chrome-bridge');
// DPAPI key access is restricted; do not retry via another mechanism.
const protectedNames = ['config.json', 'bridge_mcp_proxy.py', 'Start-TunnelClient.ps1'];
const protectedHashes = () => Object.fromEntries(protectedNames.map(n => [n, sha(fs.readFileSync(path.join(productionState, n)))]));
const before = protectedHashes();
const realConfig = JSON.parse(fs.readFileSync(path.join(productionState, 'config.json'), 'utf8'));
assert.equal(typeof realConfig.agentToken, 'string');
assert.equal(typeof realConfig.browserToken, 'string');
const config = { agentToken: 'synthetic-rollback-agent', browserToken: 'synthetic-rollback-browser' };
fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config));
save('config-format.json', { keys: Object.keys(realConfig).sort(), agentTokenType: typeof realConfig.agentToken, browserTokenType: typeof realConfig.browserToken, syntheticValuesOnlyInTest: true });
const request = async (url, token, body, extra = {}) => fetch(url, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body),
});
const rpc = async (base, token, method, params) => {
  const res = await request(base + '/mcp', token, { jsonrpc: '2.0', id: 1, method, params });
  assert.equal(res.status, 200);
  return res.json();
};
const canonical = x => JSON.stringify(x === null || typeof x !== 'object' ? x : Array.isArray(x) ? x.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(x).sort().map(k => [k, JSON.parse(canonical(x[k]))])));
async function start(exe, args, env) {
  const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  children.push({ child, exited });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(Error('Isolated startup timeout')), 8000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', () => { clearTimeout(timer); reject(Error(`Isolated child exited: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      text += chunk;
      if (text.includes('\n')) { clearTimeout(timer); resolve(`http://127.0.0.1:${Number(text.trim().split('\n')[0])}`); }
    });
  });
}
try {
  const prod = 'http://127.0.0.1:17381';
  const proxyProd = 'http://127.0.0.1:17382';
  const list = await rpc(prod, realConfig.agentToken, 'tools/list');
  const proxyList = await rpc(proxyProd, realConfig.agentToken, 'tools/list');
  assert.deepEqual(list, proxyList);
  assert.equal(list.result.tools.length, 15);
  save('production-tools-list.json', list);
  save('production-proxy-tools-list.json', proxyList);
  // Read-only CORS probe distinguishes release archive from existing CORS overlay.
  const cors = async base => {
    const r = await fetch(base + '/mcp', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://synthetic-audit' }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    return { status: r.status, allowOrigin: r.headers.get('access-control-allow-origin'), allowMethods: r.headers.get('access-control-allow-methods'), allowHeaders: r.headers.get('access-control-allow-headers'), privateNetwork: r.headers.get('access-control-allow-private-network') };
  };
  const env = { ...process.env, CHROME_BRIDGE_HOME: state, CHROME_BRIDGE_PORT: '0' };
  delete env.CHROME_BRIDGE_CODEX_POLICY;
  const moduleUrl = pathToFileURL(path.join(candidate, 'server/bridge.mjs')).href;
  const wrapper = `const m=await import(${JSON.stringify(moduleUrl)});const s=m.createBridge(m.loadConfig(),{stateDir:process.env.CHROME_BRIDGE_HOME,pollHold:60,timeout:1500});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const isolated = await start(process.execPath, ['--input-type=module', '-e', wrapper], env);
  const isolatedList = await rpc(isolated, config.agentToken, 'tools/list');
  assert.deepEqual(isolatedList, list); // Full descriptions, annotations, schemas, order and envelope.
  save('candidate-tools-list.json', isolatedList);
  const source = fs.readFileSync(path.join(productionState, 'bridge_mcp_proxy.py'), 'utf8');
  fs.writeFileSync(path.join(output, 'proxy.snapshot.py'), source);
  let isolatedProxy = source.replace("CONFIG_PATH = Path.home() / '.chrome-bridge' / 'config.json'", `CONFIG_PATH = Path(${JSON.stringify(path.join(state, 'config.json').replaceAll('\\', '/'))})`)
    .replace("LISTEN = ('127.0.0.1', 17382)", "LISTEN = ('127.0.0.1', 0)")
    .replace("UPSTREAM = 'http://127.0.0.1:17381'", `UPSTREAM = '${isolated}'`)
    .replace('ThreadingHTTPServer(LISTEN, Handler).serve_forever()', 'server = ThreadingHTTPServer(LISTEN, Handler)\nprint(server.server_port, flush=True)\nserver.serve_forever()');
  assert.notEqual(isolatedProxy, source);
  const proxy = await start(process.env.PYTHON || 'python', ['-u', '-c', isolatedProxy], env);
  assert.deepEqual(await rpc(proxy, config.agentToken, 'tools/list'), list);
  const initResults = [];
  for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    const params = { protocolVersion: version, capabilities: {}, clientInfo: { name: 'rollback-audit', version: '1' } };
    const live = await rpc(prod, realConfig.agentToken, 'initialize', params);
    assert.deepEqual(await rpc(proxy, config.agentToken, 'initialize', params), live);
    initResults.push(live.result);
  }
  for (const method of ['ping', 'server/discover']) assert.deepEqual(await rpc(prod, realConfig.agentToken, method), await rpc(proxy, config.agentToken, method));
  const liveCors = await cors(prod);
  assert.deepEqual(await cors(isolated), liveCors);
  assert.equal(liveCors.status, 204);
  assert.equal((await request(isolated + '/mcp', 'wrong', {})).status, 401);
  assert.equal((await request(isolated + '/mcp', config.browserToken, {})).status, 401);
  assert.equal((await request(proxy + '/mcp', config.agentToken, {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(proxy + '/bridge/poll', config.browserToken, {})).status, 404);
  const call = (name, args) => rpc(proxy, config.agentToken, 'tools/call', { name, arguments: args });
  const status = await call('browser_status', {});
  assert.equal(status.result.isError, undefined);
  assert.deepEqual(JSON.parse(status.result.content[0].text), { connected: false, queued: 0, agents: [] });
  const poll = async () => (await (await request(isolated + '/bridge/poll', config.browserToken, {})).json()).command;
  assert.equal(await poll(), null);
  const pending = call('browser_tabs', {});
  const command = await poll();
  assert.equal(command.name, 'browser_tabs');
  await request(isolated + '/bridge/result', config.browserToken, { id: command.id, result: [{ tabId: 1, title: 'synthetic-only' }] });
  assert.deepEqual(JSON.parse((await pending).result.content[0].text), [{ tabId: 1, title: 'synthetic-only' }]);
  for (const name of ['codex_submit', 'codex_job', 'codex_cancel']) {
    const response = await call(name, {});
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, 'Unknown tool');
  }
  // Persistent bindings/config compatibility uses only a synthetic state directory.
  fs.writeFileSync(path.join(state, 'agents.json'), JSON.stringify({ synthetic: 123 }));
  const { createBridge, loadConfig } = await import(moduleUrl);
  assert.deepEqual(loadConfig(state), config);
  const reopened = createBridge(config, { stateDir: state });
  await new Promise(resolve => reopened.listen(0, '127.0.0.1', resolve));
  try {
    const r = await rpc(`http://127.0.0.1:${reopened.address().port}`, config.agentToken, 'tools/call', { name: 'browser_status', arguments: {} });
    assert.deepEqual(JSON.parse(r.result.content[0].text).agents, [{ name: 'synthetic', tabId: 123 }]);
  } finally { await new Promise(resolve => reopened.close(resolve)); }
  // Rehearse failure and recovery on the SAME isolated upstream port while the
  // isolated proxy stays alive. Only children created above are terminated.
  const isolatedPort = new URL(isolated).port;
  const stopOwn = async entry => { if (entry.child.exitCode === null) entry.child.kill(); await entry.exited; };
  const samePortWrapper = url => `const m=await import(${JSON.stringify(url)});const s=m.createBridge(m.loadConfig(),{stateDir:process.env.CHROME_BRIDGE_HOME});s.listen(${isolatedPort},'127.0.0.1',()=>console.log(s.address().port));`;
  await stopOwn(children[0]);
  const currentUrl = pathToFileURL(path.join(root, 'server/bridge.mjs')).href;
  await start(process.execPath, ['--input-type=module', '-e', samePortWrapper(currentUrl)], env);
  const newEntry = children.at(-1);
  const newList = await rpc(proxy, config.agentToken, 'tools/list');
  assert.equal(newList.result.tools.length, 18);
  const closed = await call('codex_submit', { requestId: 'rehearsal', workspace: 'source', prompt: 'synthetic disabled probe' });
  assert.equal(closed.result.isError, true);
  assert.match(closed.result.content[0].text, /^CODEX_DISABLED:/);
  let failureDetected = false;
  try { assert.deepEqual(newList, list); } catch { failureDetected = true; }
  assert.equal(failureDetected, true);
  await stopOwn(newEntry);
  await start(process.execPath, ['--input-type=module', '-e', samePortWrapper(moduleUrl)], env);
  assert.deepEqual(await rpc(proxy, config.agentToken, 'tools/list'), list);
  assert.equal(children[1].child.exitCode, null); // proxy was never restarted
  assert.deepEqual(protectedHashes(), before);
  save('validation.json', { ok: true, toolCount: 15, fullToolObjectsEqual: true, toolListCanonicalSha256: sha(canonical(list.result.tools)), proxySnapshotSha256: sha(source), initialize: initResults, cors: liveCors, checks: ['production direct/proxy full tools/list equality', 'isolated candidate/proxy full tools/list equality', 'three protocol initialize responses equal production', 'ping/discover equality', 'CORS preflight equality', 'wrong-role/wrong-token denial', 'foreign Origin and bridge route denial via proxy', 'synthetic browser queue round trip', 'Codex unknown-tool denial; no executor present', 'synthetic config load and persisted agent binding', 'isolated same-port 15 to 18 to forced-health-failure to 15 recovery; proxy unchanged', 'config, proxy source and tunnel launcher hashes unchanged; DPAPI hash unavailable due to access denial'] });
  console.log('PASS: full production registry/schema equality, isolated proxy and config compatibility, security and synthetic queue checks.');
} finally {
  for (const { child, exited } of children.reverse()) { if (child.exitCode === null) child.kill(); await exited; }
  fs.rmSync(state, { recursive: true, force: true });
}

