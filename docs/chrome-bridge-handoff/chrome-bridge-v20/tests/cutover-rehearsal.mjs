import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const report = path.join(root, 'integration-reports/cutover-final-rehearsal');
fs.mkdirSync(report, { recursive: true });
const cases = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const safeEnv = { ...process.env }; for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'CHROME_BRIDGE_CODEX_POLICY', 'CHROME_BRIDGE_HOME', 'CHROME_BRIDGE_PORT']) delete safeEnv[k];
async function command(args, name) {
  const p = spawn('powershell.exe', ['-NoProfile', ...args], { cwd: root, env: safeEnv, windowsHide: true });
  let output = ''; p.stdout.on('data', c => output += c); p.stderr.on('data', c => output += c);
  const code = await new Promise((resolve, reject) => { p.on('error', reject); p.on('exit', resolve); });
  if (name) fs.writeFileSync(path.join(report, name + '.log'), output);
  return { code, output };
}
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  assert.ok(![17381, 17382].includes(port)); return port;
}
async function metadata(ids) {
  const r = await command(['-Command', `. '${path.join(root, 'deployment/process-identity.ps1')}'; @(${ids.join(',')}) | ForEach-Object {Get-BridgeIdentity $_} | ConvertTo-Json -Depth 4`]);
  assert.equal(r.code, 0, r.output); const x = JSON.parse(r.output); return Array.isArray(x) ? x : [x];
}
async function rpc(port, config, method, params) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.equal(r.status, 200); return r.json();
}
async function ready(port, cfg) {
  for (let i = 0; i < 60; i++) { try { return await rpc(port, cfg, 'tools/list'); } catch { await sleep(100); } }
  throw Error('Fixture startup timed out');
}
async function killIdentity(identity, dir) {
  assert.ok(![2200, 9824].includes(identity.id));
  const file = path.join(dir, 'cleanup.json'); fs.writeFileSync(file, JSON.stringify(identity));
  const r = await command(['-Command', `. '${path.join(root, 'deployment/process-identity.ps1')}'; $e=Get-Content -LiteralPath '${file.replaceAll("'", "''")}' -Raw | ConvertFrom-Json; try {$p=[Diagnostics.Process]::GetProcessById($e.id);$h=$p.Handle} catch {exit 0};try {if([BridgeNativeMetadata]::Command($h) -ceq $e.command -and $p.StartTime.ToUniversalTime().ToString('o') -eq $e.created){if(!$p.HasExited){$p.Kill();$null=$p.WaitForExit(8000)}}}finally{$p.Dispose()}`]);
  assert.equal(r.code, 0, r.output);
}
async function fixture(fault = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-final-rehearsal-'));
  const state = path.join(dir, 'state'); fs.mkdirSync(state);
  const source = path.join(dir, 'original'); fs.mkdirSync(source);
  fs.cpSync(path.join(root, 'rollback-candidates/v020-cors-recovered/server'), path.join(source, 'server'), { recursive: true });
  const cfg = { agentToken: 'rehearsal-' + crypto.randomUUID(), browserToken: 'rehearsal-' + crypto.randomUUID() };
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(state, 'Start-TunnelClient.ps1'), '# synthetic fixture only');
  const bridgePort = await freePort(), proxyPort = await freePort();
  const original = spawn(process.execPath, [path.join(source, 'server/bridge.mjs')], { env: { ...safeEnv, CHROME_BRIDGE_HOME: state, CHROME_BRIDGE_PORT: String(bridgePort) }, windowsHide: true, stdio: 'ignore' });
  await ready(bridgePort, cfg);
  let proxySource = fs.readFileSync(path.join(root, 'integration-reports/rollback-recovery/proxy.snapshot.py'), 'utf8');
  proxySource = proxySource.replace("CONFIG_PATH = Path.home() / '.chrome-bridge' / 'config.json'", `CONFIG_PATH = Path(${JSON.stringify(path.join(state, 'config.json').replaceAll('\\', '/'))})`)
    .replace("LISTEN = ('127.0.0.1', 17382)", `LISTEN = ('127.0.0.1', ${proxyPort})`).replace("UPSTREAM = 'http://127.0.0.1:17381'", `UPSTREAM = 'http://127.0.0.1:${bridgePort}'`);
  const proxyFile = path.join(state, 'bridge_mcp_proxy.py'); fs.writeFileSync(proxyFile, proxySource);
  const proxy = spawn('python', [proxyFile], { env: safeEnv, windowsHide: true, stdio: 'ignore' });
  await ready(proxyPort, cfg);
  const meta = await metadata([original.pid, proxy.pid]);
  const profile = { state, bridgePort, proxyPort, bridge: meta.find(x => x.id === original.pid), proxy: meta.find(x => x.id === proxy.pid), fault };
  const profileFile = path.join(dir, 'profile.json'); fs.writeFileSync(profileFile, JSON.stringify(profile));
  const protectedFiles = ['config.json', 'bridge_mcp_proxy.py', 'Start-TunnelClient.ps1'];
  const hashes = protectedFiles.map(n => hash(path.join(state, n)));
  const baseline = read(path.join(root, 'integration-reports/rollback-recovery/production-tools-list.json'));
  const invoke = (name, extra = []) => command(['-File', path.join(root, 'deployment/controlled-cutover.ps1'), '-RehearsalProfile', profileFile, ...extra], name);
  const verify = async count => {
    const direct = await rpc(bridgePort, cfg, 'tools/list'); const proxied = await rpc(proxyPort, cfg, 'tools/list');
    assert.deepEqual(direct, proxied); assert.equal(direct.result.tools.length, count);
    if (count === 15) assert.deepEqual(direct, baseline);
    else {
      const r = await rpc(proxyPort, cfg, 'tools/call', { name: 'codex_submit', arguments: { requestId: 'final-rehearsal', workspace: 'source', prompt: 'Synthetic disabled probe' } });
      assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /^CODEX_DISABLED:/);
    }
    assert.deepEqual(protectedFiles.map(n => hash(path.join(state, n))), hashes);
    assert.deepEqual((await metadata([proxy.pid]))[0], profile.proxy);
  };
  const cleanup = async run => {
    if (run && fs.existsSync(path.join(run, 'run.json'))) { const current = read(path.join(run, 'run.json')).current; if (current) await killIdentity(current, dir); }
    await killIdentity(profile.bridge, dir); await killIdentity(profile.proxy, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, state, cfg, profile, profileFile, invoke, verify, cleanup };
}
function runPath(result) {
  const m = result.output.match(/(?:UPGRADED|AUTO_RESTORED|PREFLIGHT_OK|ROLLED_BACK) (.+?)(?: PID=\d+)?\r?\n/);
  assert.ok(m, result.output); return m[1].trim();
}
async function scenario(name, fn) {
  const start = Date.now();
  try { const details = await fn(); cases.push({ name, ok: true, durationMs: Date.now() - start, ...details }); console.log('PASS ' + name); }
  catch (e) { cases.push({ name, ok: false, message: e.message, durationMs: Date.now() - start }); console.log('FAIL ' + name + ': ' + e.message); throw e; }
  finally { fs.writeFileSync(path.join(report, 'results.json'), JSON.stringify(cases, null, 2)); }
}

await scenario('successful-upgrade-repeat-and-explicit-rollback', async () => {
  const f = await fixture(); let run;
  try {
    const pre = await f.invoke('success-preflight'); assert.equal(pre.code, 0, pre.output); await f.verify(15);
    const namedRun = path.join(root, 'integration-reports/cutover-runs', 'named-' + crypto.randomUUID());
    const result = await f.invoke('success-upgrade', ['-Apply', '-RunDirectory', namedRun]); assert.equal(result.code, 0, result.output); run = runPath(result); assert.equal(run, namedRun); await f.verify(18);
    assert.equal(read(path.join(run, 'run.json')).status, 'UPGRADED');
    const repeat = await f.invoke('success-repeat', ['-Apply']); assert.notEqual(repeat.code, 0); await f.verify(18);
    const rollback = await f.invoke('explicit-rollback', ['-Apply', '-RollbackRun', run]); assert.equal(rollback.code, 0, rollback.output); await f.verify(15);
    const repeatRollback = await f.invoke('explicit-rollback-repeat', ['-Apply', '-RollbackRun', run]); assert.notEqual(repeatRollback.code, 0); await f.verify(15);
    return { run, result: '15в†’18в†’15; stale repeat rejected; proxy identity/config hashes unchanged' };
  } finally { await f.cleanup(run); }
});
for (const fault of ['health-failure', 'startup-exit', 'before-launch-failure']) await scenario(fault + '-automatic-rollback', async () => {
  const f = await fixture(fault); let run;
  try { const r = await f.invoke(fault, ['-Apply']); run = runPath(r); assert.notEqual(r.code, 0, r.output); assert.equal(read(path.join(run, 'run.json')).status, 'AUTO_RESTORED'); await f.verify(15); return { run }; }
  finally { await f.cleanup(run); }
});
await scenario('identity-mismatch-preserves-unrelated-node-and-python', async () => {
  const f = await fixture();
  try {
    f.profile.bridge.created = '2000-01-01T00:00:00.0000000Z'; fs.writeFileSync(f.profileFile, JSON.stringify(f.profile));
    const r = await f.invoke('wrong-identity', ['-Apply']); assert.notEqual(r.code, 0); assert.match(r.output, /identity mismatch/i);
    // Preserve actual identity for fixture cleanup.
    f.profile.bridge = (await metadata([f.profile.bridge.id]))[0];
    const real = f.profile.bridge.command; f.profile.bridge.command = real + ' --unrelated'; fs.writeFileSync(f.profileFile, JSON.stringify(f.profile));
    const commandMismatch = await f.invoke('wrong-command', ['-Apply']); assert.notEqual(commandMismatch.code, 0); assert.match(commandMismatch.output, /identity mismatch/i);
    f.profile.bridge.command = real; await f.verify(15);
    const actualBridge = f.profile.bridge, actualProxy = f.profile.proxy;
    f.profile.bridge = actualProxy; f.profile.proxy = actualBridge; fs.writeFileSync(f.profileFile, JSON.stringify(f.profile));
    const pythonTarget = await f.invoke('python-not-bridge', ['-Apply']); assert.notEqual(pythonTarget.code, 0); assert.match(pythonTarget.output, /Not the expected Node executable/);
    f.profile.bridge=actualBridge; f.profile.proxy=actualProxy; await f.verify(15);
    return { result: 'wrong creation time rejected before termination; both fixture processes alive' };
  } finally { await f.cleanup(); }
});
await scenario('occupied-listener-wrong-owner-rejected', async () => {
  const f = await fixture(); const blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  try {
    f.profile.bridgePort = blocker.address().port; fs.writeFileSync(f.profileFile, JSON.stringify(f.profile));
    const r = await f.invoke('occupied-port', ['-Apply']); assert.notEqual(r.code, 0); assert.match(r.output, /Listener mismatch/); assert.equal(blocker.listening, true);
    // Original direct/proxy endpoints still answer; profile was modified only in test file.
    const result = await rpc(f.profile.proxyPort, f.cfg, 'tools/list'); assert.equal(result.result.tools.length, 15);
    return { result: 'unrelated listener not terminated; original Bridge/proxy remain alive' };
  } finally { await new Promise(r => blocker.close(r)); await f.cleanup(); }
});
await scenario('production-targets-rejected-in-rehearsal', async () => {
  const f = await fixture();
  try {
    f.profile.bridgePort = 17381; fs.writeFileSync(f.profileFile, JSON.stringify(f.profile));
    const r = await f.invoke('production-port-denied', ['-Apply']); assert.notEqual(r.code, 0); assert.match(r.output, /cannot target production/);
    return { result: 'blocked before lock, health queries or process handles' };
  } finally { await f.cleanup(); }
});
async function paused(f) {
  for (let i = 0; i < 150; i++) { if (fs.existsSync(path.join(f.state, 'paused.json'))) return read(path.join(f.state, 'paused.json')); await sleep(100); }
  throw Error('Pause checkpoint not reached');
}
await scenario('concurrent-run-lock-and-complete-upgrade', async () => {
  const f = await fixture('pause-before-stop'); let run, first;
  try {
    first = f.invoke('concurrent-first', ['-Apply']); run = (await paused(f)).run;
    const second = await f.invoke('concurrent-second', ['-Apply']); assert.notEqual(second.code, 0); assert.match(second.output, /being used by another process|Open.*exception|IOException/i);
    fs.writeFileSync(path.join(f.state, 'continue'), 'continue isolated test');
    const result = await first; assert.equal(result.code, 0, result.output); await f.verify(18); return { run, result: 'second controller rejected; first succeeds' };
  } finally { fs.writeFileSync(path.join(f.state, 'continue'), 'cleanup'); if (first) await first; await f.cleanup(run); }
});
await scenario('staged-source-tamper-before-stop-rejected', async () => {
  const f = await fixture('pause-before-stop'); let run, first;
  try {
    first = f.invoke('source-tamper', ['-Apply']); run = (await paused(f)).run;
    fs.appendFileSync(path.join(run, 'candidate/server/bridge.mjs'), '\n// synthetic tamper\n');
    fs.writeFileSync(path.join(f.state, 'continue'), 'continue isolated test');
    const result = await first; assert.notEqual(result.code, 0); assert.match(result.output, /Staged source changed/); await f.verify(15); return { run };
  } finally { fs.writeFileSync(path.join(f.state, 'continue'), 'cleanup'); if (first) await first; await f.cleanup(); }
});
await scenario('port-stolen-after-stop-safe-recovery-refusal', async () => {
  const f = await fixture('pause-after-stop'); const blocker = net.createServer(); let run, first;
  try {
    first = f.invoke('port-stolen', ['-Apply']); run = (await paused(f)).run;
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(f.profile.bridgePort, '127.0.0.1', resolve); });
    fs.writeFileSync(path.join(f.state, 'continue'), 'continue isolated test');
    const result = await first; assert.notEqual(result.code, 0); assert.equal(read(path.join(run, 'run.json')).status, 'RECOVERY_REQUIRED'); assert.equal(blocker.listening, true);
    assert.deepEqual((await metadata([f.profile.proxy.id]))[0], f.profile.proxy);
    return { run, result: 'occupant preserved; no second server; explicit RECOVERY_REQUIRED rather than false success' };
  } finally { fs.writeFileSync(path.join(f.state, 'continue'), 'cleanup'); if (first) await first; if (blocker.listening) await new Promise(r => blocker.close(r)); await f.cleanup(run); }
});
await scenario('wrong-rollback-source-fails-before-stop', async () => {
  const f = await fixture();
  try { const r = await f.invoke('bad-rollback', ['-Apply', '-RollbackSource', root]); assert.notEqual(r.code, 0); await f.verify(15); return { result: '18-tool rollback rejected against complete 15-tool schema baseline' }; }
  finally { await f.cleanup(); }
});
await scenario('same-count-schema-drift-rejected-before-stop', async () => {
  const f = await fixture();
  try {
    const drift = path.join(f.dir, 'drift'); fs.mkdirSync(drift);
    fs.cpSync(path.join(root, 'rollback-candidates/v020-cors-recovered/server'), path.join(drift, 'server'), { recursive: true });
    const file = path.join(drift, 'server/tools.mjs'); const source = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, source.replace('Check whether the Chrome control tab is connected.', 'SYNTHETIC SCHEMA DRIFT'));
    const r = await f.invoke('schema-drift', ['-Apply', '-RollbackSource', drift]); assert.notEqual(r.code, 0); await f.verify(15);
    return { result: '15 tools with identical names but changed definition rejected' };
  } finally { await f.cleanup(); }
});
console.log(`Completed ${cases.length} scenarios`);

