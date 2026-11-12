import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsCodexRunner } from './windows-codex-lab-runner.mjs';

test('write-enabled lab runner never requests danger-full-access', { skip: process.platform !== 'win32' }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cb-runner-test-'));
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n'));
      child.emit('close', 0);
    });
  };
  let launchArgs, verified = false;
  const supervisor = {
    async launchContained(options) { launchArgs = options; return child; },
    async terminateAndVerify(received) { assert.equal(received, child); verified = true; },
  };
  try {
    const runner = createWindowsCodexRunner({ executable: 'C:\\Tools\\codex.exe', supervisor, platform: 'win32' });
    const result = await runner.run({ requestId: 'test_1', workspace, prompt: 'reply OK' });
    assert.equal(result.text, 'OK');
    assert.deepEqual(launchArgs.args.slice(0, 5), ['exec','--json','--skip-git-repo-check','--sandbox','workspace-write']);
    assert.equal(launchArgs.args.includes('danger-full-access'), false);
    assert.equal(launchArgs.cwd, workspace);
    await runner.terminateTree('test_1');
    assert.equal(verified, true);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('nonzero Codex exit still awaits native tree cleanup', { skip: process.platform !== 'win32' }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cb-runner-failure-'));
  const child = new EventEmitter();
  child.pid = 12346;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => queueMicrotask(() => child.emit('close', 7));
  let cleaned = false;
  const supervisor = {
    async launchContained() { return child; },
    async terminateAndVerify() { cleaned = true; },
  };
  try {
    const runner = createWindowsCodexRunner({ executable: 'C:\\Tools\\codex.exe', supervisor, platform: 'win32' });
    await assert.rejects(runner.run({ requestId: 'failure_1', workspace, prompt: 'test' }), /CODEX_EXIT_NONZERO/);
    assert.equal(cleaned, true);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
