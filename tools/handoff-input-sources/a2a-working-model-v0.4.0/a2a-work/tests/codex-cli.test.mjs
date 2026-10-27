import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Ledger } from '../src/ledger.mjs';
import { runOnce } from '../src/dispatcher.mjs';
import { CodexCliAdapter } from '../src/adapters/codex-cli.mjs';
import { createA2AServer } from '../src/server.mjs';

async function fakeCodex(dir) {
  const file = path.join(dir, 'fake-codex.mjs');
  await fs.writeFile(file, `#!/usr/bin/env node\nimport fs from 'node:fs';\nlet input=''; for await (const c of process.stdin) input += c;\nconst args=process.argv.slice(2); const oi=args.indexOf('--output-last-message');\nif(oi<0) process.exit(31); fs.writeFileSync(args[oi+1], 'REAL-CODEX-RESULT: '+input.trim());\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'thread-test-123'}));\nconsole.log(JSON.stringify({type:'turn.completed'}));\n`);
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
  assert.equal(result.text, `REAL-CODEX-RESULT: ${text}`);
  assert.equal(result.invocationId, 'thread-test-123');
  await assert.rejects(fs.access(path.join(dir, 'injected-file')));
});

test('end-to-end JSON-RPC HTTP submission reaches Codex adapter and returns real process result', async t => {
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
  assert.match(completed.result.artifacts[0].parts[0].text, /REAL-CODEX-RESULT: Compute 2\+2/);
  assert.equal(completed.result.artifacts[0].metadata.invocationId, 'thread-test-123');
});

test('Codex adapter rejects unsafe sandbox settings', () => {
  assert.throws(() => new CodexCliAdapter({ cwd: process.cwd(), sandbox: 'danger-full-access' }), /INVALID_CODEX_SANDBOX/);
});
