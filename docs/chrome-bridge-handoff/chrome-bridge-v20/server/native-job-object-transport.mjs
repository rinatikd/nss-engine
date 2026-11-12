// Lab-only native supervisor transport. The native binary is intentionally not yet shipped.
// No fallback to plain spawn: failure to start or malformed protocol fails closed.
import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_LINE = 64 * 1024;
const MAX_WAIT_MS = 15000;
const MAX_STDERR = 64 * 1024;
const REQ_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export function createNativeJobObjectTransport({ supervisorExe, spawnProcess = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') throw Error('WINDOWS_ONLY');
  if (typeof supervisorExe !== 'string' || !path.win32.isAbsolute(supervisorExe) ||
      supervisorExe.startsWith('\\\\') || !/\.exe$/i.test(supervisorExe)) throw Error('INVALID_SUPERVISOR_EXE');
  const jobs = new Map();
  return {
    async launchContained({ executable, args = [], cwd, requestId }) {
      if (typeof executable !== 'string' || !path.win32.isAbsolute(executable) ||
          executable.startsWith('\\\\') || !/\.exe$/i.test(executable) ||
          typeof cwd !== 'string' || !path.win32.isAbsolute(cwd) ||
          !REQ_ID.test(requestId ?? '') ||
          !Array.isArray(args) || args.some(x => typeof x !== 'string' || x.includes('\0'))) {
        throw Error('INVALID_CONTAINED_LAUNCH');
      }
      if (jobs.has(requestId)) throw Error('SUPERVISOR_DUPLICATE');
      // Native supervisor contract: the process must be created suspended and
      // assigned to a kill-on-close Job Object BEFORE it is resumed.
      const child = spawnProcess(supervisorExe, ['--stdio-v1'], {
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const job = { child, requestId, buffer: '', done: false, waiters: [], failed: null, stderrBytes: 0 };
      jobs.set(requestId, job);
      const fail = err => {
        if (job.failed) return;
        job.failed = err;
        // Preserve fail-closed state: never forget an unverified job.
        try { child.kill(); } catch {}
        for (const w of job.waiters.splice(0)) w.reject(err);
      };
      child.on('error', () => fail(Error('SUPERVISOR_START_FAILED')));
      child.on('exit', () => { if (!job.done) fail(Error('SUPERVISOR_EXIT_UNCONFIRMED')); });
      child.stderr.on('data', chunk => {
        job.stderrBytes += chunk.length;
        if (job.stderrBytes > MAX_STDERR) fail(Error('SUPERVISOR_STDERR_OVERFLOW'));
      });
      child.stdout.on('data', chunk => {
        job.buffer += chunk.toString('utf8');
        if (Buffer.byteLength(job.buffer) > MAX_LINE) return fail(Error('SUPERVISOR_PROTOCOL_OVERFLOW'));
        let n;
        while ((n = job.buffer.indexOf('\n')) >= 0) {
          const line = job.buffer.slice(0, n); job.buffer = job.buffer.slice(n + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { return fail(Error('SUPERVISOR_INVALID_JSON')); }
          if (msg?.requestId !== requestId || !['ready', 'terminated'].includes(msg.type)) {
            return fail(Error('SUPERVISOR_INVALID_MESSAGE'));
          }
          const w = job.waiters.shift();
          if (!w || w.type !== msg.type) return fail(Error('SUPERVISOR_UNEXPECTED_MESSAGE'));
          w.resolve(msg);
        }
      });
      const awaitMessage = type => new Promise((resolve, reject) => {
        if (job.failed) return reject(job.failed);
        const entry = { type, resolve, reject };
        job.waiters.push(entry);
        const timer = setTimeout(() => {
          job.waiters = job.waiters.filter(x => x !== entry);
          reject(Error('SUPERVISOR_ACK_TIMEOUT'));
        }, MAX_WAIT_MS);
        entry.resolve = value => { clearTimeout(timer); resolve(value); };
        entry.reject = error => { clearTimeout(timer); reject(error); };
      });
      try {
        const ready = awaitMessage('ready');
        child.stdin.write(JSON.stringify({ type: 'launch', requestId, executable, args, cwd }) + '\n');
        const msg = await ready;
        if (!Number.isInteger(msg.pid) || msg.pid <= 0 || msg.contained !== true) throw Error('SUPERVISOR_NOT_CONTAINED');
        return { pid: msg.pid, requestId, supervisor: child, stdout: child.stdout, stderr: child.stderr, stdin: child.stdin,
          once: child.once.bind(child), on: child.on.bind(child) };
      } catch (error) {
        // Retain the job ID when a launched supervisor cannot confirm cleanup.
        // A failed handshake must not silently authorize a duplicate request.
        fail(error);
        throw error;
      }
    },
    async terminateAndVerify(handle) {
      const job = jobs.get(handle?.requestId);
      if (!job || job.child !== handle.supervisor) throw Error('UNKNOWN_SUPERVISOR_JOB');
      // No acknowledgement is treated as an unconfirmed cleanup, not success.
      const ack = new Promise((resolve, reject) => {
        if (job.failed) return reject(job.failed);
        const entry = { type: 'terminated', resolve, reject };
        job.waiters.push(entry);
        const timer = setTimeout(() => {
          job.waiters = job.waiters.filter(x => x !== entry);
          reject(Error('SUPERVISOR_CLEANUP_TIMEOUT'));
        }, MAX_WAIT_MS);
        entry.resolve = value => { clearTimeout(timer); resolve(value); };
        entry.reject = error => { clearTimeout(timer); reject(error); };
      });
      if (job.failed) throw Error('SUPERVISOR_CLEANUP_UNCONFIRMED');
      job.child.stdin.write(JSON.stringify({ type: 'terminate', requestId: job.requestId }) + '\n');
      const msg = await ack;
      if (msg.activeProcesses !== 0 || msg.verified !== true) throw Error('SUPERVISOR_CLEANUP_UNCONFIRMED');
      job.done = true;
      jobs.delete(job.requestId);
      job.child.stdin.end();
    },
  };
}
