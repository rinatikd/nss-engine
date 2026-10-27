import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ledger } from '../src/ledger.mjs';
import { runOnce } from '../src/dispatcher.mjs';
import { CodexCliAdapter } from '../src/adapters/codex-cli.mjs';
import { createA2AServer } from '../src/server.mjs';

async function fakeCodex(dir) {
  const file = path.join(dir, 'fake-codex.mjs');
  await fs.writeFile(file, `#!/usr/bin/env node\nimport fs from 'node:fs';\nlet input=''; for await (const c of process.stdin) input += c;\nconst args=process.argv.slice(2); fs.writeFileSync(${JSON.stringify(path.join(dir, 'captured-args.json'))},JSON.stringify(args)); const oi=args.indexOf('--output-last-message');\nif(oi<0) process.exit(31); fs.writeFileSync(args[oi+1], 'FIXTURE-CODEX-RESULT: '+input.trim());\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'thread-test-123'}));\nconsole.log(JSON.stringify({type:'turn.completed'}));\n`);
  await fs.chmod(file, 0o755);
  return file;
}

test('Codex CLI adapter invokes a process without shell-interpolating task text and captures final output', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-codex-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = await fakeCodex(dir);
  const adapter = new CodexCliAdapter({ executable, cwd: dir, timeoutMs: 5000 });
  const text = 'echo NOT_A_COMMAND; $(touch injected-file)';
  const result = await adapter.send({ text });
  assert.equal(result.kind, 'response');
  assert.equal(result.text, `FIXTURE-CODEX-RESULT: ${text}`);
  assert.equal(result.invocationId, 'thread-test-123');
  await assert.rejects(fs.access(path.join(dir, 'injected-file')));
});

test('end-to-end JSON-RPC HTTP submission reaches Codex adapter and returns fixture process result', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-e2e-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = await fakeCodex(dir);
  const db = path.join(dir, 'ledger.sqlite');
  const token = 'test-token-with-more-than-24-characters';
  const ledger = new Ledger(db);
  const server = createA2AServer({ ledger, token, agentUrl: 'http://127.0.0.1:0', defaultRecipient: 'codex' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); ledger.close(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/a2a+json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'e2e-1', method: 'message/send', params: { message: { role: 'user', messageId: 'm1', contextId: 'e2e-context', parts: [{ kind: 'text', text: 'Compute 2+2 and report the result.' }] } } }) });
  const submitted = await response.json();
  assert.equal(submitted.result.status.state, 'submitted');
  const adapter = new CodexCliAdapter({ name: 'codex', executable, cwd: dir, timeoutMs: 5000 });
  const dispatched = await runOnce({ ledger, adapter, owner: 'test-codex-worker', ttlMs: 10000 });
  assert.equal(dispatched.status, 'completed');
  const poll = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/a2a+json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'e2e-2', method: 'tasks/get', params: { id: submitted.result.id } }) });
  const completed = await poll.json();
  assert.equal(completed.result.status.state, 'completed');
  assert.match(completed.result.artifacts[0].parts[0].text, /FIXTURE-CODEX-RESULT: Compute 2\+2/);
  assert.equal(completed.result.artifacts[0].metadata.invocationId, 'thread-test-123');
});

test('Codex adapter rejects unsafe sandbox settings', () => {
  assert.throws(() => new CodexCliAdapter({ cwd: process.cwd(), sandbox: 'danger-full-access' }), /INVALID_CODEX_SANDBOX/);
});


test('approval is a global CLI option and installed CLI accepts the generated argv (parse only)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-argv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = await fakeCodex(dir);
  await new CodexCliAdapter({ executable, cwd: dir, timeoutMs: 5000 }).send({ text: 'synthetic' });
  const args = JSON.parse(await fs.readFile(path.join(dir, 'captured-args.json'), 'utf8'));
  assert.deepEqual(args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.equal(args.filter(x => x === '--ask-for-approval').length, 1);
  const installed = spawnSync('codex', ['--version'], { encoding: 'utf8', shell: false });
  if (installed.error?.code === 'ENOENT') return t.skip('Codex CLI not installed; generated argv checked with process fixture only');
  assert.equal(installed.status, 0, installed.stderr);
  const parsed = spawnSync('codex', [...args.slice(0, -1), '--help'], { encoding: 'utf8', shell: false, timeout: 5000 });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /Run Codex non-interactively/);
});

test('generic extra arguments cannot override tools, sandbox or configuration', () => {
  for (const extraArgs of [ ['--dangerously-bypass-approvals-and-sandbox'], ['--yolo'], ['--sandbox', 'danger-full-access'], ['--enable', 'shell_tool'], ['-c', 'approval_policy="on-request"'], ['--profile', 'other'], ['--skip-git-repo-check', '--skip-git-repo-check'] ]) {
    assert.throws(() => new CodexCliAdapter({ cwd: process.cwd(), extraArgs }), /INVALID_CODEX_EXTRA_ARGS/);
  }
  assert.doesNotThrow(() => new CodexCliAdapter({ cwd: process.cwd(), extraArgs: ['--skip-git-repo-check'] }));
});

test('Windows configuration requires an absolute native exe rather than cmd shell dispatch', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const executable of ['codex', 'codex.cmd', 'C:\\Tools\\codex.cmd', 'C:\\Tools\\codex.bat', 'codex.exe']) {
      assert.throws(() => new CodexCliAdapter({ cwd: process.cwd(), executable }), /CODEX_WINDOWS_NATIVE_EXE_REQUIRED/);
    }
    assert.doesNotThrow(() => new CodexCliAdapter({ cwd: process.cwd(), executable: 'C:\\Tools\\codex.exe' }));
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('missing CLI executable is proven not dispatched and does not become an ambiguous result', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-missing-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(new CodexCliAdapter({ executable: path.join(dir, 'missing'), cwd: dir }).send({ text: 'synthetic' }), e => e.name === 'NotDispatched');
});

test('missing external session id never becomes a fabricated attested invocation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-session-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'no-id.mjs');
  await fs.writeFile(executable, `#!/usr/bin/env node\nimport fs from 'node:fs'; for await (const c of process.stdin) {} const args=process.argv.slice(2); fs.writeFileSync(args[args.indexOf('--output-last-message')+1], 'synthetic result');\n`);
  await fs.chmod(executable, 0o755);
  const ledger = new Ledger(path.join(dir, 'ledger.sqlite')); t.after(() => ledger.close());
  ledger.submit({ id: 'no-id', contextId: 'session-test', sender: 'client', recipient: 'codex', text: 'synthetic' });
  assert.equal((await runOnce({ ledger, adapter: new CodexCliAdapter({ executable, cwd: dir }), owner: 'test-worker' })).status, 'completed');
  const artifact = ledger.events('no-id').find(e => e.kind === 'completed').body.artifact;
  assert.equal(artifact.meta.invocationId, null);
  assert.equal(artifact.meta.attested, false);
});

test('timeout terminates the Unix process group instead of waiting indefinitely for inherited pipes', { skip: process.platform === 'win32' ? 'Unix process-group check; Windows descendant containment is unverified' : false }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-timeout-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'descendants.mjs');
  await fs.writeFile(executable, `#!/usr/bin/env node\nimport {spawn} from 'node:child_process'; spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000);\n`);
  await fs.chmod(executable, 0o755);
  const started = Date.now();
  await assert.rejects(new CodexCliAdapter({ executable, cwd: dir, timeoutMs: 1000 }).send({ text: 'synthetic' }), /CODEX_TIMEOUT_OUTCOME_UNKNOWN/);
  assert.ok(Date.now() - started < 5000, 'timeout plus termination grace must bound the wait');
});

test('local Codex mode is explicit and cannot broaden permission or choose a cloud model', () => {
  for (const settings of [{provider:'other'}, {provider:'ollama-local',model:'cloud-model'},
    {provider:'ollama-local',model:'qwen2.5:3b',sandbox:'workspace-write'},
    {provider:'ollama-local',model:'qwen2.5:3b',approval:'on-request'},
    {provider:'ollama-local',model:'qwen2.5:3b',localPort:0}]) {
    assert.throws(()=>new CodexCliAdapter({cwd:process.cwd(),...settings}));
  }
});

test('local mode isolates config and inherited model credentials, fixes loopback provider and disables tools', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'a2a-local-args-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const executable=path.join(dir,'capture-local.mjs');
  await fs.writeFile(executable,`#!/usr/bin/env node\nimport fs from 'node:fs';for await(const c of process.stdin){}const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(path.join(dir,'capture.json'))},JSON.stringify({args,base:process.env.CODEX_OSS_BASE_URL,config:process.env.CODEX_HOME,marker:process.env.A2A_SYNTHETIC_PARENT_CREDENTIAL,openai:!!process.env.OPENAI_API_KEY,anthropic:!!process.env.ANTHROPIC_API_KEY}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'synthetic fixture');\n`);
  await fs.chmod(executable,0o755);
  const previous=process.env.A2A_SYNTHETIC_PARENT_CREDENTIAL;process.env.A2A_SYNTHETIC_PARENT_CREDENTIAL='must-not-reach-child';
  try {
    await new CodexCliAdapter({executable,cwd:dir,provider:'ollama-local',model:'qwen2.5:3b',localPort:12345}).send({text:'fixture'});
  } finally {if(previous===undefined)delete process.env.A2A_SYNTHETIC_PARENT_CREDENTIAL;else process.env.A2A_SYNTHETIC_PARENT_CREDENTIAL=previous;}
  const value=JSON.parse(await fs.readFile(path.join(dir,'capture.json'),'utf8'));
  assert.equal(value.base,'http://127.0.0.1:12345/v1');assert.equal(value.marker,undefined);
  assert.equal(value.openai,false);assert.equal(value.anthropic,false);
  assert.ok(value.args.includes('--oss')&&value.args.includes('--ignore-user-config')&&value.args.includes('--ignore-rules'));
  assert.equal(value.args[value.args.indexOf('--local-provider')+1],'ollama');
  assert.ok(value.args.includes('web_search="disabled"'));
  assert.ok(value.args.includes('tools.experimental_request_user_input.enabled=false'));
  assert.ok(value.args.includes('tools.update_plan.enabled=false'));
  await assert.rejects(fs.access(value.config),'isolated child home is removed after the invocation');
});
