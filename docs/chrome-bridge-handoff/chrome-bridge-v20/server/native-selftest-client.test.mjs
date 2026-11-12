import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeSelftest } from './native-selftest-client.mjs';

const exe = process.env.CB_NATIVE_SUPERVISOR_EXE ||
  join(tmpdir(), 'chrome-bridge-job-object-supervisor', 'job-object-supervisor.exe');
const enabled = process.platform === 'win32' && existsSync(exe);

test('self-only native supervisor returns ready then OS-verified terminated', { skip: !enabled }, async () => {
  const result = await runNativeSelftest({ supervisorExe: exe, timeoutMs: 10000 });
  assert.equal(result.scope, 'self-only-lab');
  assert.equal(result.ready.contained, true);
  assert.ok(result.ready.pid > 0);
  assert.equal(result.terminated.verified, true);
  assert.equal(result.terminated.activeProcesses, 0);
  assert.equal(result.exitCode, 0);
});
test('reject invalid executable path before spawning', async () => {
  await assert.rejects(
    runNativeSelftest({ supervisorExe: 'relative\\supervisor.exe' }),
    process.platform === 'win32' ? /INVALID_SUPERVISOR_PATH/ : /WINDOWS_ONLY/,
  );
});
