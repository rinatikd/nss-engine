// Real Windows process-lifecycle checks. No Codex, network, production or elevation.
// Uses the self-only native supervisor test mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const exe = join(tmpdir(), 'chrome-bridge-job-object-supervisor', 'job-object-supervisor.exe');
const skip = process.platform !== 'win32' || !existsSync(exe);

function alive(pid) {
  // OpenProcess SYNCHRONIZE can observe even a terminating process.
  // PowerShell Get-Process may fail with an access error; treat as unconfirmed.
  const script = '$p=Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if($null -eq $p){"ABSENT"} else {"PRESENT"}';
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 4000 }).trim();
  if (output === 'ABSENT') return false;
  if (output === 'PRESENT') return true;
  throw Error('PID_STATE_UNCONFIRMED');
}
async function awaitAbsent(pid, timeout = 4000) {
  const deadline = Date.now() + timeout;
  do {
    if (!alive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail('CONTAINED_PID_STILL_PRESENT: ' + pid);
}
function start() {
  return spawn(exe, ['--stdio-v1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}
function ack(child, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(Error('ACK_TIMEOUT')); }, timeout);
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const pos = buffer.indexOf('\n');
      if (pos >= 0) {
        cleanup();
        try { resolve(JSON.parse(buffer.slice(0, pos))); } catch (e) { reject(e); }
      }
    }
    function onExit() { cleanup(); reject(Error('EXIT_BEFORE_ACK')); }
    function cleanup() { clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}
function exited(child, timeout = 5000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('SUPERVISOR_EXIT_TIMEOUT')); }, timeout);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
  });
}
async function launch(child, id) {
  const pending = ack(child);
  child.stdin.write(JSON.stringify({
    type: 'launch', requestId: id, executable: exe,
    args: ['--contained-child'], cwd: dirname(exe),
  }) + '\n');
  const message = await pending;
  assert.equal(message.type, 'ready');
  assert.equal(message.requestId, id);
  assert.equal(message.contained, true);
  assert.ok(Number.isInteger(message.pid) && message.pid > 0);
  assert.equal(alive(message.pid), true, 'Child must be observable before termination');
  return message.pid;
}
test('terminate ACK and independent child PID disappearance', { skip }, async () => {
  const child = start();
  let pid;
  try {
    pid = await launch(child, 'lifecycle-normal');
    const pending = ack(child);
    child.stdin.write(JSON.stringify({ type: 'terminate', requestId: 'lifecycle-normal' }) + '\n');
    const message = await pending;
    assert.equal(message.type, 'terminated');
    assert.equal(message.verified, true);
    assert.equal(message.activeProcesses, 0);
    await exited(child);
    await awaitAbsent(pid);
  } finally {
    child.kill();
    if (pid) await awaitAbsent(pid);
  }
});
test('control-channel EOF kills contained child PID', { skip }, async () => {
  const child = start();
  let pid;
  try {
    pid = await launch(child, 'lifecycle-eof');
    child.stdin.end();
    assert.notEqual(await exited(child), 0);
    await awaitAbsent(pid);
  } finally {
    child.kill();
    if (pid) await awaitAbsent(pid);
  }
});
test('forced supervisor termination kills contained child PID', { skip }, async () => {
  const child = start();
  let pid;
  try {
    pid = await launch(child, 'lifecycle-crash');
    assert.equal(child.kill(), true);
    await exited(child);
    await awaitAbsent(pid);
  } finally {
    child.kill();
    if (pid) await awaitAbsent(pid);
  }
});
