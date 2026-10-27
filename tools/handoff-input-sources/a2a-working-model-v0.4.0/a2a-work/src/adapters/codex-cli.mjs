import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Codex CLI adapter for durable A2A dispatch.
 * The ledger writes dispatch_started before this adapter is called. Therefore any failure
 * after spawn begins is deliberately ambiguous and the dispatcher moves the task to UNKNOWN.
 * Never use --yolo / danger-full-access here; sandbox is explicit and defaults to read-only.
 */
export class CodexCliAdapter {
  constructor({ name = 'codex', executable = 'codex', cwd, model, timeoutMs = 600000,
    sandbox = 'read-only', approval = 'never', extraArgs = [] } = {}) {
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error('INVALID_CODEX_ADAPTER_NAME');
    if (typeof executable !== 'string' || !executable.trim()) throw new Error('INVALID_CODEX_EXECUTABLE');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('CODEX_CWD_MUST_BE_ABSOLUTE');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('INVALID_CODEX_TIMEOUT');
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('INVALID_CODEX_SANDBOX');
    if (!['never', 'on-request'].includes(approval)) throw new Error('INVALID_CODEX_APPROVAL');
    if (!Array.isArray(extraArgs) || extraArgs.some(x => typeof x !== 'string' || x.startsWith('--yolo') || x.includes('dangerously-bypass-approvals-and-sandbox'))) throw new Error('INVALID_CODEX_EXTRA_ARGS');
    this.name = name; this.executable = executable; this.cwd = cwd; this.model = model || null;
    this.timeoutMs = timeoutMs; this.sandbox = sandbox; this.approval = approval; this.extraArgs = extraArgs;
  }

  async send(task) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-codex-'));
    const outputFile = path.join(temp, 'last-message.txt');
    const args = ['exec', '--json', '--ephemeral', '--sandbox', this.sandbox, '--ask-for-approval', this.approval,
      '--output-last-message', outputFile, '--cd', this.cwd];
    if (this.model) args.push('--model', this.model);
    args.push(...this.extraArgs, '-'); // prompt travels on stdin, never through shell argument parsing
    const invocationId = crypto.randomUUID();
    let stdout = '', stderr = '', sessionId = null, timedOut = false, spawned = false;
    try {
      const result = await new Promise((resolve, reject) => {
        // Windows needs shell dispatch for codex.cmd; prompt is stdin and all other args are adapter config.
        const child = spawn(this.executable, args, { cwd: this.cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000); force.unref(); }, this.timeoutMs);
        child.once('spawn', () => { spawned = true; child.stdin.end(task.text); });
        child.stdout.on('data', b => { stdout = boundedAppend(stdout, b.toString(), 1024 * 1024); });
        child.stderr.on('data', b => { stderr = boundedAppend(stderr, b.toString(), 256 * 1024); });
        child.once('error', e => { clearTimeout(timer); if (!spawned) { e.code = 'CODEX_NOT_STARTED'; reject(e); } else reject(e); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      if (!spawned) throw new Error('CODEX_NOT_STARTED');
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { const event = JSON.parse(line); if (typeof event.thread_id === 'string') sessionId = event.thread_id; if (typeof event.session_id === 'string') sessionId = event.session_id; } catch { /* tolerate non-JSON diagnostics */ }
      }
      if (timedOut) throw new Error('CODEX_TIMEOUT_OUTCOME_UNKNOWN');
      if (result.code !== 0) throw new Error(`CODEX_EXIT_${result.code ?? result.signal ?? 'UNKNOWN'}: ${stderr.slice(-1200)}`);
      let text;
      try { text = await fs.readFile(outputFile, 'utf8'); } catch { throw new Error('CODEX_FINAL_OUTPUT_MISSING'); }
      if (!text.trim()) throw new Error('CODEX_FINAL_OUTPUT_EMPTY');
      return { kind: 'response', text: text.trim(), invocationId: sessionId ?? invocationId };
    } catch (e) {
      // spawn failures prove no child process started; every later failure is ambiguous.
      if (!spawned && e?.code === 'CODEX_NOT_STARTED') {
        const { NotDispatched } = await import('../dispatcher.mjs');
        throw new NotDispatched('CODEX_EXECUTABLE_NOT_STARTED');
      }
      throw e;
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
}
function boundedAppend(current, addition, max) { return (current + addition).slice(-max); }
