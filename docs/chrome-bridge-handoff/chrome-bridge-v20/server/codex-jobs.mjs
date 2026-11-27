import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { findSecret } from './secrets.mjs';
import { validateArgs } from './schema.mjs';
import { toolByName } from './tools.mjs';

const terminal = (j) => !['queued', 'running'].includes(j.status);
const safeText = (text) => findSecret(text) || /(?:password|secret|token|api[_-]?key)\s*[=:]/i.test(text) ? '[REDACTED: sensitive result]' : text;

export function createCodexJobs({ policy, storeDir, concurrency = 1, maxQueued = 8, maxRecords = 1000, retentionMs = 86400000 } = {}) {
  if (!policy || !storeDir || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 100) throw Error('INVALID_JOB_POLICY');
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const file = path.join(storeDir, 'jobs.json');
  const jobs = new Map();
  const requests = new Map();
  const live = new Map();
  const prompts = new Map();
  let stopped = false;
  const save = () => {
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify([...jobs.values()]), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch {
      stopped = true;
      prompts.clear();
      for (const j of jobs.values()) if (!terminal(j)) {
        j.error = 'STORE_FAILED';
        if (!live.has(j.jobId)) j.status = 'interrupted';
      }
      for (const [id, run] of live) {
        clearTimeout(run.timer); run.stopping = true;
        run.termination ??= Promise.resolve().then(() => run.handle.terminateTree()).then(() => {
          const j = jobs.get(id); j.status = 'interrupted'; j.error = 'STORE_FAILED'; live.delete(id);
        }, () => { jobs.get(id).error = 'TERMINATION_UNCONFIRMED'; });
      }
      return false;
    }
  };
  const prune = () => {
    for (const [id, j] of jobs) if (terminal(j) && Date.now() - j.updatedAt > retentionMs) { jobs.delete(id); requests.delete(j.requestId); }
  };
  if (fs.existsSync(file)) {
    for (const j of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (!terminal(j)) { j.status = 'interrupted'; j.error = 'BRIDGE_RESTARTED'; j.updatedAt = Date.now(); }
      jobs.set(j.jobId, j); requests.set(j.requestId, j);
    }
    prune(); if (!save()) throw Error('STORE_FAILED');
  }
  const view = (j) => {
    const { fingerprint, requestId, ...publicJob } = j;
    return structuredClone(publicJob);
  };
  const lookup = (id) => { const j = jobs.get(id); if (!j) throw Error('JOB_NOT_FOUND'); return j; };
  function finish(j, status, error = null, exitCode = j.exitCode ?? null) {
    if (terminal(j)) return;
    j.status = status; j.error = error; j.exitCode = exitCode; j.updatedAt = Date.now();
    j.durationMs = j.startedAt ? j.updatedAt - j.startedAt : 0;
    j.logs.push({ at: j.updatedAt, event: status });
    prompts.delete(j.jobId); save();
  }
  function stop(j, status, error) {
    const run = live.get(j.jobId);
    if (run?.stopping) return;
    if (!run) { finish(j, status, error); pump(); return; }
    run.stopping = true; clearTimeout(run.timer);
    // Slots remain occupied until the supervisor confirms the entire tree is dead.
    run.termination = Promise.resolve().then(() => run.handle.terminateTree()).then(() => {
      finish(j, status, error); live.delete(j.jobId); pump();
    }, () => { j.error = 'TERMINATION_UNCONFIRMED'; save(); });
  }
  function start(j) {
    j.status = 'running'; j.startedAt = j.updatedAt = Date.now(); j.logs.push({ at: j.updatedAt, event: 'running' }); if (!save()) return;
    let handle;
    try {
      handle = policy.launch(j.workspace);
      if (!handle?.child || typeof handle.terminateTree !== 'function') throw Error();
    } catch { finish(j, 'failed', 'LAUNCH_FAILED'); return; }
    const child = handle.child;
    const run = { handle, stopping: false, completed: false, text: '', bytes: 0, stderr: 0, line: '', decoder: new StringDecoder('utf8') };
    live.set(j.jobId, run);
    const fail = (reason) => stop(j, 'failed', reason);
    const line = (s) => {
      if (!s.trim() || run.stopping) return;
      try {
        const e = JSON.parse(s);
        if (e.type === 'turn.completed') run.completed = true;
        if (e.type === 'turn.failed' || e.type === 'error') return fail('CODEX_ERROR');
        if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') run.text = e.item.text;
      } catch { fail('INVALID_JSONL'); }
    };
    child.stdout.on('data', (chunk) => {
      if (run.stopping) return;
      run.bytes += Buffer.byteLength(chunk);
      if (run.bytes > 2 * 1024 * 1024) return fail('OUTPUT_LIMIT');
      run.line += run.decoder.write(Buffer.from(chunk));
      let i;
      while ((i = run.line.indexOf('\n')) >= 0) {
        const s = run.line.slice(0, i); run.line = run.line.slice(i + 1);
        if (Buffer.byteLength(s) > 262144) return fail('LINE_LIMIT');
        line(s);
      }
      if (Buffer.byteLength(run.line) > 262144) fail('LINE_LIMIT');
    });
    child.stderr.on('data', (chunk) => { run.stderr += Buffer.byteLength(chunk); if (run.stderr > 262144) fail('STDERR_LIMIT'); });
    child.stdin.on('error', () => fail('STDIN_FAILED'));
    child.on('error', () => fail('PROCESS_FAILED'));
    child.on('close', (code) => {
      if (run.stopping) return;
      run.line += run.decoder.end(); line(run.line);
      if (run.stopping) return;
      // Even a normal exit must reap descendants before releasing capacity.
      j.result = code === 0 && run.completed && run.text ? { text: safeText(run.text) } : null;
      stop(j, j.result ? 'succeeded' : 'failed', j.result ? null : 'INCOMPLETE_OR_FAILED');
      j.exitCode = code;
    });
    run.timer = setTimeout(() => stop(j, 'timed_out', 'TIMEOUT'), j.timeoutSec * 1000);
    try { child.stdin.end(prompts.get(j.jobId)); prompts.delete(j.jobId); } catch { fail('STDIN_FAILED'); }
  }
  function pump() {
    if (stopped) return;
    for (const j of jobs.values()) {
      if (live.size >= concurrency) break;
      if (j.status === 'queued') start(j);
    }
  }
  return {
    async call(name, args) {
      validateArgs(toolByName(name), args);
      if (name === 'codex_submit') {
        if (stopped) throw Error('BRIDGE_STOPPED');
        if (Buffer.byteLength(args.prompt) > 32768 || findSecret(args.prompt)) throw Error('PROMPT_REJECTED');
        const timeoutSec = args.timeoutSec ?? 120;
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([args.workspace, args.prompt, timeoutSec])).digest('hex');
        prune(); if (!save()) throw Error('STORE_FAILED');
        const prior = requests.get(args.requestId);
        if (prior) { if (prior.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT'); return view(prior); }
        policy.check(args.workspace);
        if (jobs.size >= maxRecords || [...jobs.values()].filter(j => !terminal(j)).length >= concurrency + maxQueued) throw Error('BUSY');
        const j = { jobId: crypto.randomUUID(), requestId: args.requestId, fingerprint, workspace: args.workspace, timeoutSec, status: 'queued', mode: 'read-only', createdAt: Date.now(), updatedAt: Date.now(), result: null, error: null, logs: [{ at: Date.now(), event: 'queued' }] };
        jobs.set(j.jobId, j); requests.set(j.requestId, j); prompts.set(j.jobId, args.prompt);
        try { if (!save()) throw Error(); } catch { jobs.delete(j.jobId); requests.delete(j.requestId); prompts.delete(j.jobId); throw Error('STORE_FAILED'); }
        pump(); return view(j);
      }
      const j = lookup(args.jobId);
      if (name === 'codex_cancel') { if (!terminal(j)) stop(j, 'cancelled', 'CANCELLED'); return view(j); }
      const end = Date.now() + (args.waitSec ?? 0) * 1000;
      while (!terminal(j) && Date.now() < end) await new Promise(r => setTimeout(r, Math.min(50, end - Date.now())));
      return view(j);
    },
    async close() {
      stopped = true;
      for (const j of jobs.values()) if (!terminal(j)) stop(j, 'interrupted', 'BRIDGE_STOPPED');
      await Promise.all([...live.values()].map(r => r.termination));
    },
  };
}

