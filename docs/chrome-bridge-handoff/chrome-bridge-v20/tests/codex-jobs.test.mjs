import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCodexJobs } from '../server/codex-jobs.mjs';
import { createCodexPolicy } from '../server/codex-policy.mjs';
import { createBridge } from '../server/bridge.mjs';

const tick = () => new Promise(r => setTimeout(r, 10));
function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-'));
  const launched = [];
  const policy = {
    check(w) { if (w !== 'source') throw Error('WORKSPACE_DENIED'); },
    launch(w) {
      this.check(w);
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      let input = '';
      child.stdin.on('data', c => { input += c; });
      const run = { child, get input() { return input; }, killed: false, terminateTree: async () => { run.killed = true; } };
      launched.push(run); return run;
    },
  };
  const jobs = createCodexJobs({ policy, storeDir: dir, ...overrides });
  t.after(async () => { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const submit = (requestId = 'r1', args = {}) => jobs.call('codex_submit', { requestId, workspace: 'source', prompt: 'Explain source', ...args });
  const get = id => jobs.call('codex_job', { jobId: id });
  return { jobs, launched, submit, get, dir, policy };
}
function complete(run, text = 'Answer', code = 0) {
  const events = [{ type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' }];
  const data = events.map(e => JSON.stringify(e)).join('\n');
  run.child.stdout.write(data.slice(0, 13)); run.child.stdout.write(data.slice(13));
  run.child.emit('close', code);
}

test('literal stdin, split JSONL, bounded logs and final answer only', async t => {
  const s = setup(t);
  const prompt = '--flag "quote"\n$(whoami); & echo x';
  const j = await s.submit('literal', { prompt });
  assert.equal(s.launched[0].input, prompt);
  s.launched[0].child.stdout.write('{"type":"item.completed","item":{"type":"reasoning","text":"private reasoning"}}\n');
  s.launched[0].child.stderr.write('secret diagnostic');
  complete(s.launched[0]); await tick();
  const result = await s.get(j.jobId);
  assert.equal(result.status, 'succeeded'); assert.equal(result.exitCode, 0);
  assert.deepEqual(result.result, { text: 'Answer' });
  assert.equal(s.launched[0].killed, true);
  assert.doesNotMatch(JSON.stringify(result), /diagnostic|reasoning|fingerprint|requestId/);
  assert.doesNotMatch(fs.readFileSync(path.join(s.dir, 'jobs.json'), 'utf8'), /whoami|diagnostic|reasoning/);
});

test('idempotency, conflict, queue capacity, queued cancellation and slot release', async t => {
  const s = setup(t, { maxQueued: 1 });
  const [a, dup] = await Promise.all([s.submit(), s.submit()]);
  assert.equal(a.jobId, dup.jobId); assert.equal(s.launched.length, 1);
  await assert.rejects(s.submit('r1', { prompt: 'changed' }), /IDEMPOTENCY_CONFLICT/);
  const b = await s.submit('r2'); assert.equal(b.status, 'queued');
  await assert.rejects(s.submit('r3'), /BUSY/);
  await s.jobs.call('codex_cancel', { jobId: b.jobId });
  assert.equal((await s.get(b.jobId)).status, 'cancelled');
  const c = await s.submit('r3');
  complete(s.launched[0]); await tick();
  assert.equal(s.launched.length, 2); assert.equal((await s.get(c.jobId)).status, 'running');
});

test('running cancel is idempotent and wins late completion', async t => {
  const s = setup(t); const j = await s.submit();
  await s.jobs.call('codex_cancel', { jobId: j.jobId });
  await s.jobs.call('codex_cancel', { jobId: j.jobId });
  complete(s.launched[0]); await tick();
  assert.equal((await s.get(j.jobId)).status, 'cancelled');
  assert.equal(s.launched[0].killed, true);
});

test('timeout terminates tree; polling timeout leaves execution running', async t => {
  const s = setup(t); const j = await s.submit('r1', { timeoutSec: 1 });
  assert.equal((await s.jobs.call('codex_job', { jobId: j.jobId, waitSec: 0 })).status, 'running');
  const result = await s.jobs.call('codex_job', { jobId: j.jobId, waitSec: 2 });
  assert.equal(result.status, 'timed_out'); assert.equal(s.launched[0].killed, true);
});

for (const [name, output, code, reason] of [
  ['malformed', '{oops}\n', 0, 'INVALID_JSONL'],
  ['oversized line', 'x'.repeat(262145), 0, 'LINE_LIMIT'],
  ['flood', 'x'.repeat(2097153), 0, 'OUTPUT_LIMIT'],
  ['missing completion', '{"type":"thread.started"}\n', 0, 'INCOMPLETE_OR_FAILED'],
  ['nonzero', '{"type":"turn.completed"}\n', 1, 'INCOMPLETE_OR_FAILED'],
]) test(name + ' fails safely', async t => {
  const s = setup(t); const j = await s.submit();
  s.launched[0].child.stdout.write(output); s.launched[0].child.emit('close', code); await tick();
  const result = await s.get(j.jobId);
  assert.equal(result.status, 'failed'); assert.equal(result.error, reason); assert.equal(s.launched[0].killed, true);
});

test('secrets are refused or redacted; raw errors never persisted', async t => {
  const s = setup(t);
  await assert.rejects(s.submit('secret', { prompt: 'sk-abcdefghijklmnopqrstuvwxyz123456' }), /PROMPT_REJECTED/);
  const j = await s.submit(); complete(s.launched[0], 'Bearer abcdefghijklmnopqrstuvwxyz123456'); await tick();
  assert.match((await s.get(j.jobId)).result.text, /REDACTED/);
  assert.doesNotMatch(fs.readFileSync(path.join(s.dir, 'jobs.json'), 'utf8'), /abcdefghijklmnopqrstuvwxyz/);
});

test('validation rejects workspace paths, extra flags, limits and unknown jobs', async t => {
  const s = setup(t);
  for (const args of [{ workspace: '../escape' }, { workspace: 'other' }, { timeoutSec: 301 }, { executable: 'evil' }, { prompt: 'a'.repeat(32769) }]) await assert.rejects(s.submit('x', args));
  await assert.rejects(s.get('00000000-0000-4000-8000-000000000000'), /JOB_NOT_FOUND/);
  assert.equal(s.launched.length, 0);
});

test('restart marks unresolved jobs interrupted and reuses reservation', async t => {
  const s = setup(t); const a = await s.submit(); const b = await s.submit('queued');
  const restarted = createCodexJobs({ policy: s.policy, storeDir: s.dir });
  assert.equal((await restarted.call('codex_job', { jobId: a.jobId })).status, 'interrupted');
  assert.equal((await restarted.call('codex_submit', { requestId: 'queued', workspace: 'source', prompt: 'Explain source' })).jobId, b.jobId);
  assert.equal(s.launched.length, 1); await restarted.close();
});

test('policy fixes argv, requires isolation and excludes inherited environment', () => {
  let spec;
  const policy = createCodexPolicy({ executable: process.execPath, workspaces: { source: process.cwd() }, runner: { verify: () => true, launch: (...args) => { spec = args; } } });
  policy.launch('source');
  assert.equal(spec[2].shell, false); assert.deepEqual(spec[2].env, {});
  assert.ok(spec[1].includes('--ignore-user-config')); assert.ok(spec[1].includes('read-only')); assert.equal(spec[1].at(-1), '-');
  assert.throws(() => policy.check('other'), /WORKSPACE_DENIED/);
  assert.throws(() => createCodexPolicy({ executable: process.execPath, workspaces: {} }), /ISOLATED_RUNNER_REQUIRED/);
  const denied = createCodexPolicy({ executable: process.execPath, workspaces: { source: process.cwd() }, runner: { verify: () => false, launch() {} } });
  assert.throws(() => denied.check('source'), /ISOLATION_UNAVAILABLE/);
});

test('MCP dispatch works without Chrome, rejects browser credentials and defaults disabled', async t => {
  const s = setup(t);
  for (const enabled of [false, true]) {
    const server = createBridge({ agentToken: 'agent', browserToken: 'browser' }, { codexJobs: enabled ? s.jobs : null });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const call = token => fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'codex_submit', arguments: { requestId: 'mcp', workspace: 'source', prompt: 'Explain' } } }) });
      assert.equal((await call('browser')).status, 401);
      const body = await (await call('agent')).json();
      if (enabled) assert.equal(JSON.parse(body.result.content[0].text).status, 'running');
      else assert.match(body.result.content[0].text, /CODEX_DISABLED/);
    } finally { await new Promise(r => server.close(r)); }
  }
});

test('stderr flooding, launch failure and process errors do not expose diagnostics', async t => {
  const s = setup(t);
  const a = await s.submit();
  s.launched[0].child.stderr.write('s'.repeat(262145)); await tick();
  assert.equal((await s.get(a.jobId)).error, 'STDERR_LIMIT');
  const b = await s.submit('b');
  s.launched[1].child.emit('error', Error('password=do-not-expose')); await tick();
  assert.equal((await s.get(b.jobId)).error, 'PROCESS_FAILED');
  s.policy.launch = () => { throw Error('token=do-not-expose'); };
  const c = await s.submit('c'); assert.equal(c.error, 'LAUNCH_FAILED');
  assert.doesNotMatch(fs.readFileSync(path.join(s.dir, 'jobs.json'), 'utf8'), /do-not-expose/);
});

test('concurrency limit two and blocked termination retains occupied slot', async t => {
  const s = setup(t, { concurrency: 2 });
  const a = await s.submit('a'); await s.submit('b');
  const c = await s.submit('c'); assert.equal(c.status, 'queued'); assert.equal(s.launched.length, 2);
  s.launched[0].terminateTree = async () => { throw Error('private detail'); };
  await s.jobs.call('codex_cancel', { jobId: a.jobId }); await tick();
  assert.equal((await s.get(a.jobId)).error, 'TERMINATION_UNCONFIRMED');
  assert.equal(s.launched.length, 2);
  complete(s.launched[1]); await tick(); assert.equal(s.launched.length, 3);
});

test('path policy rejects relative, UNC, device and ADS workspace paths', () => {
  for (const cwd of ['../escape', '\\\\server\\share', '\\\\?\\C:\\secret', 'C:\\source:stream']) {
    assert.throws(() => createCodexPolicy({ executable: process.execPath, workspaces: { source: cwd }, runner: { verify: () => true, launch() {} } }));
  }
});

test('storage failure blocks launches and terminates existing execution', async t => {
  const s = setup(t); const j = await s.submit();
  fs.mkdirSync(path.join(s.dir, 'jobs.json.tmp'));
  await assert.rejects(s.submit('second'), /STORE_FAILED/); await tick();
  assert.equal(s.launched.length, 1); assert.equal(s.launched[0].killed, true);
  assert.equal((await s.get(j.jobId)).error, 'STORE_FAILED');
  await assert.rejects(s.submit('third'), /BRIDGE_STOPPED/);
});

test('shutdown interrupts queued and running jobs, and refuses more submissions', async t => {
  const s = setup(t); const a = await s.submit(); const b = await s.submit('b');
  await s.jobs.close();
  assert.equal(s.launched[0].killed, true);
  for (const id of [a.jobId, b.jobId]) assert.equal((await s.get(id)).status, 'interrupted');
  await assert.rejects(s.submit('c'), /BRIDGE_STOPPED/);
});

