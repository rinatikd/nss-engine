import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsCodexRunner } from '../server/windows-codex-lab-runner.mjs';

test('rejects non-Windows and relative executable paths', () => {
  assert.throws(() => createWindowsCodexRunner({ platform:'linux', executable:'C:\\codex.exe' }), /WINDOWS_ONLY/);
  assert.throws(() => createWindowsCodexRunner({ platform:'win32', executable:'codex.exe' }), /INVALID_CODEX_EXECUTABLE/);
});
test('rejects nonexistent workspace before spawning', async () => {
  let spawned = false;
  const runner = createWindowsCodexRunner({
    platform:'win32', executable:'C:\\codex.exe',
    spawnProcess: () => { spawned = true; throw Error('SHOULD_NOT_SPAWN'); },
  });
  await assert.rejects(runner.run({requestId:'x',workspace:'C:\\not-a-real-workspace-987654',prompt:'test'}));
  assert.equal(spawned,false);
});
