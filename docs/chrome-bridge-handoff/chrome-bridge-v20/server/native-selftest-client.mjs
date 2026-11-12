// Lab-only Node ↔ native Job Object supervisor transport.
// The native --stdio-v1 mode permits ONLY spawning its own --contained-child.
// Not a Codex launcher, not a general process runner, not a security attestation.
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBrokerFrameDecoder, encodeBrokerFrame } from './native-broker-protocol.mjs';

const MAX_BUFFER = 65537;
const PROTOCOL_TIMEOUT = 5000;

function oneFrame(child, requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const decoder = createBrokerFrameDecoder(requestId);
    let settled = false;
    const timer = setTimeout(() => finish(Error('IPC_ACK_TIMEOUT')), timeoutMs);
    const onData = (chunk) => {
      try {
        const value = decoder.push(chunk);
        if (value) finish(null, value);
      } catch (e) { finish(e); }
    };
    const onExit = () => finish(Error('IPC_SUPERVISOR_EXIT'));
    const onError = () => finish(Error('IPC_SUPERVISOR_ERROR'));
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (err) reject(err); else resolve(value);
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function exitWait(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => { cleanup(); reject(Error('IPC_EXIT_TIMEOUT')); }, timeoutMs);
    const onExit = code => { cleanup(); resolve(code); };
    const onError = () => { cleanup(); reject(Error('IPC_SUPERVISOR_ERROR')); };
    function cleanup() { clearTimeout(timer); child.off('exit', onExit); child.off('error', onError); }
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export async function runNativeSelftest({ supervisorExe, timeoutMs = PROTOCOL_TIMEOUT } = {}) {
  if (process.platform !== 'win32') throw Error('WINDOWS_ONLY');
  if (typeof supervisorExe !== 'string' || !path.win32.isAbsolute(supervisorExe) ||
      supervisorExe.startsWith('\\\\') || !supervisorExe.toLowerCase().endsWith('.exe'))
    throw Error('INVALID_SUPERVISOR_PATH');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000)
    throw Error('INVALID_TIMEOUT');
  const requestId = 'lab_' + crypto.randomUUID().replaceAll('-', '');
  const child = spawn(supervisorExe, ['--stdio-v1'], {
    stdio: ['pipe','pipe','pipe'], windowsHide: true, shell: false,
  });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > MAX_BUFFER) child.kill(); });
  try {
    const readyPromise = oneFrame(child, requestId, timeoutMs);
    // The native restricted selftest only accepts its own path and fixed argument.
    child.stdin.write(encodeBrokerFrame({
      type: 'launch', requestId, executable: supervisorExe,
      args: ['--contained-child'],
    }));
    const ready = await readyPromise;
    if (ready.type !== 'ready') throw Error('IPC_EXPECTED_READY');
    const terminatedPromise = oneFrame(child, requestId, timeoutMs);
    child.stdin.end(encodeBrokerFrame({ type: 'terminate', requestId }));
    const terminated = await terminatedPromise;
    if (terminated.type !== 'terminated') throw Error('IPC_EXPECTED_TERMINATED');
    const exitCode = await exitWait(child, timeoutMs);
    if (exitCode !== 0) throw Error('IPC_SUPERVISOR_NONZERO');
    return { requestId, ready, terminated, exitCode, scope: 'self-only-lab' };
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    try { await exitWait(child, timeoutMs); } catch {}
    throw error;
  }
}
