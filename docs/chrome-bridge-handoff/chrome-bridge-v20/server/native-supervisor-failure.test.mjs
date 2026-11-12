// Windows native IPC negative tests. No Codex, network, or production endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = join(tmpdir(), 'chrome-bridge-job-object-supervisor', 'job-object-supervisor.exe');
const enabled = process.platform === 'win32' && existsSync(exe);

function start() {
  return spawn(exe, ['--stdio-v1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
function waitExit(child, ms = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(Error('NATIVE_EXIT_TIMEOUT'));
    }, ms);
    child.once('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    });
  });
}
function readLine(child, ms = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { cleanup(); reject(Error('NATIVE_ACK_TIMEOUT')); }, ms);
    const onData = chunk => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) { cleanup(); try { resolve(JSON.parse(buf.slice(0, i))); } catch (err) { reject(err); } }
    };
    const onExit = () => { cleanup(); reject(Error('NATIVE_EXIT_BEFORE_ACK')); };
    function cleanup() { clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}
function launchLine(id) {
  return JSON.stringify({ type: 'launch', requestId: id, executable: exe, args: ['--contained-child'], cwd: join(tmpdir(), 'chrome-bridge-job-object-supervisor') }) + '\n';
}

test('reject malformed launch input', { skip: !enabled }, async () => {
  const child = start();
  const exited = waitExit(child);
  child.stdin.end('{not-json}\n');
  assert.notEqual(await exited, 0);
});

test('reject arbitrary executable', { skip: !enabled }, async () => {
  const child = start();
  const exited = waitExit(child);
  child.stdin.end(JSON.stringify({ type: 'launch', requestId: 'reject-exe', executable: 'C:\\Windows\\System32\\cmd.exe', args: ['--contained-child'] }) + '\n');
  assert.notEqual(await exited, 0);
});

test('disconnect stdin after ready terminates supervisor and contained child', { skip: !enabled }, async () => {
  const child = start();
  try {
    const exited = waitExit(child);
    const ack = readLine(child);
    child.stdin.write(launchLine('disconnect-001'));
    const ready = await ack;
    assert.equal(ready.type, 'ready');
    assert.equal(ready.contained, true);
    assert.ok(ready.pid > 0);
    // EOF on control channel must close the kill-on-close job handle.
    child.stdin.end();
    assert.notEqual(await exited, 0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
