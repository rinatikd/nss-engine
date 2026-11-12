// Real native binary integration test; requires local MSVC build first.
// No Codex execution. Native supervisor permits only its own --contained-child.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createNativeJobObjectTransport } from './native-job-object-transport.mjs';

test('real Windows supervisor stdio-v1 self-only launch and terminate', { skip: process.platform !== 'win32' }, async () => {
  const exe = path.join(os.tmpdir(), 'chrome-bridge-job-object-supervisor', 'job-object-supervisor.exe');
  assert.ok(fs.existsSync(exe), 'Build native binary using Run-SupervisorSelfTest.ps1 first');
  const transport = createNativeJobObjectTransport({ supervisorExe: exe });
  const requestId = 'native-ipc-test-001';
  const handle = await transport.launchContained({
    executable: exe, args: ['--contained-child'], cwd: path.dirname(exe), requestId,
  });
  assert.ok(handle.pid > 0);
  await transport.terminateAndVerify(handle);
});
