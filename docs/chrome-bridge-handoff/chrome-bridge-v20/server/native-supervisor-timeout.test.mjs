// IPC v1.3: bounded cancellation and timeout, real native self-only child.
// Test harness enforces deadlines; native supervisor does not yet have its own watchdog.
// No Codex, external executables, network, or production access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const exe = join(tmpdir(), 'chrome-bridge-job-object-supervisor', 'job-object-supervisor.exe');
const skip = process.platform !== 'win32' || !existsSync(exe);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function isAlive(pid) {
  const ps = '$p=Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if($null -eq $p){"ABSENT"}else{"PRESENT"}';
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', timeout: 4000 }).trim();
  if (output !== 'ABSENT' && output !== 'PRESENT') throw Error('PID_STATE_UNCONFIRMED');
  return output === 'PRESENT';
}
async function assertAbsent(pid) {
  for (let i = 0; i < 60; i++) {
    if (!isAlive(pid)) return;
    await pause(50);
  }
  assert.fail('CHILD_STILL_ALIVE: ' + pid);
}
function start() {
  return spawn(exe, ['--stdio-v1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
function message(child, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(Error('ACK_TIMEOUT')); }, timeout);
    const onData = data => {
      buffer += data.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index !== -1) {
        cleanup();
        try { resolve(JSON.parse(buffer.slice(0, index))); } catch (error) { reject(error); }
      }
    };
    const onExit = () => { cleanup(); reject(Error('EXIT_BEFORE_ACK')); };
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}
function exited(child, timeout = 4000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('SUPERVISOR_EXIT_TIMEOUT')); }, timeout);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
  });
}
async function launch(child, id) {
  const response = message(child);
  child.stdin.write(JSON.stringify({
    type: 'launch', requestId: id, executable: exe,
    args: ['--contained-child'], cwd: dirname(exe),
  }) + '\n');
  const ready = await response;
  assert.equal(ready.type, 'ready');
  assert.equal(ready.contained, true);
  assert.ok(Number.isInteger(ready.pid) && ready.pid > 0);
  assert.equal(isAlive(ready.pid), true);
  return ready.pid;
}
async function terminate(child, id) {
  const response = message(child);
  child.stdin.write(JSON.stringify({ type: 'terminate', requestId: id }) + '\n');
  const ack = await response;
  assert.equal(ack.type, 'terminated');
  assert.equal(ack.verified, true);
  assert.equal(ack.activeProcesses, 0);
  await exited(child);
}
test('operator cancellation confirms child PID cleanup', { skip }, async () => {
  const child = start();
  let pid;
  try {
    pid = await launch(child, 'cancel-v13');
    await terminate(child, 'cancel-v13');
    await assertAbsent(pid);
  } finally {
    child.kill();
    if (pid) await assertAbsent(pid);
  }
});
test('Node watchdog timeout closes supervisor and kills child', { skip }, async () => {
  const child = start();
  let pid;
  try {
    pid = await launch(child, 'timeout-v13');
    // Bounded test watchdog: close control pipe when the short deadline expires.
    await pause(150);
    child.stdin.end();
    assert.notEqual(await exited(child), 0);
    await assertAbsent(pid);
  } finally {
    child.kill();
    if (pid) await assertAbsent(pid);
  }
});
test('wrong cancellation request ID fails closed and kills child', { skip }, async () => {
  const child = start();
  let pid;
  try {
    pid = await launch(child, 'cancel-correct-v13');
    child.stdin.end(JSON.stringify({ type: 'terminate', requestId: 'cancel-wrong-v13' }) + '\n');
    assert.notEqual(await exited(child), 0);
    await assertAbsent(pid);
  } finally {
    child.kill();
    if (pid) await assertAbsent(pid);
  }
});
