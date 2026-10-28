import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Keep extra switches explicit: generic config/feature/profile switches can change the
// effective tools and permissions, so they are not accepted as transport configuration.
const EXTRA_FLAGS = new Set(['--skip-git-repo-check']);
const LOCAL_MODELS = new Set(['qwen2.5:3b', 'qwen2.5:7b']);
const LOCAL_DISABLED_FEATURES = ['shell_tool','unified_exec','apps','plugins','remote_plugin',
  'multi_agent','browser_use','computer_use','goals','view_image','image_generation','sleep_tool','tool_suggest'];
const LOCAL_ENV_KEYS = ['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','HTTP_PROXY','HTTPS_PROXY',
  'http_proxy','https_proxy','NO_PROXY','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE'];

/**
 * The ledger commits dispatch_started before send(). Only a proven spawn failure is
 * NotDispatched; timeout, pipe failure and every other later failure remain UNKNOWN.
 * Windows requires a native executable; .cmd dispatch through cmd.exe is not used.
 * This adapter is not proof of filesystem, network or external-tool isolation.
 */
export class CodexCliAdapter {
  constructor({ name = 'codex', executable = 'codex', cwd, model, timeoutMs = 600000,
    sandbox = 'read-only', approval = 'never', extraArgs = [], provider = 'configured', localPort = 11434 } = {}) {
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error('INVALID_CODEX_ADAPTER_NAME');
    if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) throw new Error('INVALID_CODEX_EXECUTABLE');
    if (process.platform === 'win32' && (!path.win32.isAbsolute(executable) || path.win32.extname(executable).toLowerCase() !== '.exe')) throw new Error('CODEX_WINDOWS_NATIVE_EXE_REQUIRED');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('CODEX_CWD_MUST_BE_ABSOLUTE');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('INVALID_CODEX_TIMEOUT');
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('INVALID_CODEX_SANDBOX');
    if (!['never', 'on-request'].includes(approval)) throw new Error('INVALID_CODEX_APPROVAL');
    if (!Array.isArray(extraArgs) || extraArgs.some(x => !EXTRA_FLAGS.has(x)) || new Set(extraArgs).size !== extraArgs.length) throw new Error('INVALID_CODEX_EXTRA_ARGS');
    if (!['configured', 'ollama-local'].includes(provider)) throw new Error('INVALID_CODEX_PROVIDER');
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('INVALID_LOCAL_PORT');
    if (provider === 'ollama-local' && (!LOCAL_MODELS.has(model) || sandbox !== 'read-only' || approval !== 'never')) throw new Error('LOCAL_CODEX_REQUIRES_PINNED_MODEL_AND_READONLY');
    this.provider = provider; this.localPort = localPort;
    this.name = name; this.executable = executable; this.cwd = cwd; this.model = model || null;
    this.timeoutMs = timeoutMs; this.sandbox = sandbox; this.approval = approval; this.extraArgs = [...extraArgs];
  }

  async send(task, { signal } = {}) {
    if (signal?.aborted) {
      const { NotDispatched } = await import('../dispatcher.mjs');
      throw new NotDispatched('CODEX_ABORTED_BEFORE_START');
    }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-codex-'));
    const outputFile = path.join(temp, 'last-message.txt');
    // Approval is a top-level Codex option, not an exec subcommand option.
    const args = ['--ask-for-approval', this.approval, 'exec', '--json', '--ephemeral', '--sandbox', this.sandbox,
      '--output-last-message', outputFile, '--cd', this.cwd];
    if (this.model) args.push('--model', this.model);
    let childEnv = process.env;
    if (this.provider === 'ollama-local') {
      const configHome = path.join(temp, 'isolated-codex');
      await fs.mkdir(configHome, { mode: 0o700 });
      // An app-local selector for this subprocess only; never copies cached login/config.
      childEnv = Object.fromEntries(LOCAL_ENV_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
      childEnv.CODEX_HOME = configHome;
      childEnv.CODEX_OSS_BASE_URL = `http://127.0.0.1:${this.localPort}/v1`;
      childEnv.NO_PROXY = [childEnv.NO_PROXY || childEnv.no_proxy || '', '127.0.0.1', 'localhost'].filter(Boolean).join(',');
      args.push('--oss', '--local-provider', 'ollama', '--ignore-user-config', '--ignore-rules');
      for (const feature of LOCAL_DISABLED_FEATURES) args.push('--disable', feature);
      args.push('-c', 'web_search="disabled"', '-c', 'tools.experimental_request_user_input.enabled=false',
        '-c', 'tools.update_plan.enabled=false', '-c', 'model_context_window=8192');
    }
    args.push(...this.extraArgs, '-');
    let stdout = '', stderr = '', sessionId = null, cliError = '', timedOut = false, aborted = false, spawned = false, stdinFailed = false;
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(this.executable, args, { cwd: this.cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
        let force, stopping = false;
        const terminate = signal => {
          if (!child.pid) return;
          try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
          catch (e) { if (e.code !== 'ESRCH') { /* outcome remains unknown; settlement is bounded below */ } }
        };
        const clearTimers = () => { clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', abort); };
        const stop = () => {
          if (stopping) return;
          stopping = true;
          terminate('SIGTERM');
          force = setTimeout(() => {
            terminate('SIGKILL');
            // A detached descendant can retain the pipe handles. Do not let those
            // handles turn a declared timeout into an unbounded wait for close().
            child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
            reject(new Error(aborted ? 'CODEX_ABORTED_OUTCOME_UNKNOWN' : 'CODEX_TIMEOUT_OUTCOME_UNKNOWN'));
          }, 3000);
        };
        const abort = () => { aborted = true; stop(); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, this.timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        child.stdin.on('error', () => { stdinFailed = true; });
        child.once('spawn', () => { spawned = true; child.stdin.end(task.text); });
        child.stdout.on('data', b => { stdout = boundedAppend(stdout, b.toString(), 1024 * 1024); });
        child.stderr.on('data', b => { stderr = boundedAppend(stderr, b.toString(), 256 * 1024); });
        child.once('error', e => { clearTimers(); if (!spawned) e.code = 'CODEX_NOT_STARTED'; reject(e); });
        // The detached group is ours. Once its leader exits, no helper may
        // outlive the invocation or retain pipes; do not cancel cleanup just
        // because close() arrived before the timeout/abort force timer.
        child.once('exit', () => { if (process.platform !== 'win32') terminate('SIGKILL'); });
        child.once('close', (code, signal) => { clearTimers(); resolve({ code, signal }); });
      });
      if (!spawned) throw new Error('CODEX_NOT_STARTED');
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { const event = JSON.parse(line); if (event.type === 'error' && typeof event.message === 'string') cliError = event.message; if (event.type === 'turn.failed' && typeof event.error?.message === 'string') cliError = event.error.message; if (typeof event.thread_id === 'string' && event.thread_id) sessionId = event.thread_id; if (typeof event.session_id === 'string' && event.session_id) sessionId = event.session_id; } catch { /* tolerate non-JSON diagnostics */ }
      }
      if (aborted) throw new Error('CODEX_ABORTED_OUTCOME_UNKNOWN');
      if (timedOut) throw new Error('CODEX_TIMEOUT_OUTCOME_UNKNOWN');
      if (stdinFailed) throw new Error('CODEX_STDIN_OUTCOME_UNKNOWN');
      if (result.code !== 0) throw new Error(`CODEX_EXIT_${result.code ?? result.signal ?? 'UNKNOWN'}: ${(stderr + (this.provider === 'ollama-local' ? '\n' + cliError : '')).slice(-1800)}`);
      let text;
      try { text = await fs.readFile(outputFile, 'utf8'); } catch { throw new Error('CODEX_FINAL_OUTPUT_MISSING'); }
      if (!text.trim()) throw new Error('CODEX_FINAL_OUTPUT_EMPTY');
      // A locally generated UUID is not evidence of an external invocation.
      return { kind: 'response', text: text.trim(), invocationId: sessionId };
    } catch (e) {
      if (!spawned && e?.code === 'CODEX_NOT_STARTED') {
        const { NotDispatched } = await import('../dispatcher.mjs');
        throw new NotDispatched('CODEX_EXECUTABLE_NOT_STARTED');
      }
      throw e;
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
}
function boundedAppend(current, addition, max) { return (current + addition).slice(-max); }
