// Experimental Windows-only Codex supervisor for a LOCAL, explicitly approved lab.
// Not connected to production MCP. Runs with the permissions of the current Windows user.
// No elevation, credential changes, firewall changes or shell invocation.
import fs from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT = 1024 * 1024;
const MAX_PROMPT = 32768;

export function createWindowsCodexRunner({
  executable,
  supervisor,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') throw Error('WINDOWS_ONLY');
  if (typeof executable !== 'string' || !path.win32.isAbsolute(executable) ||
      executable.startsWith('\\\\') || !/\.exe$/i.test(executable)) throw Error('INVALID_CODEX_EXECUTABLE');
  // A native Windows Job Object supervisor must launch suspended, assign to a job,
  // then resume. Plain spawn/taskkill is not sufficient process containment.
  if (!supervisor || typeof supervisor.launchContained !== 'function' ||
      typeof supervisor.terminateAndVerify !== 'function') throw Error('JOB_OBJECT_SUPERVISOR_REQUIRED');
  const active = new Map();
  return {
    async run({ requestId, workspace, prompt, timeoutSec = 120, signal }) {
      if (typeof requestId !== 'string' || !requestId) throw Error('INVALID_REQUEST_ID');
      if (active.has(requestId)) throw Error('RUNNER_DUPLICATE');
      if (typeof workspace !== 'string' || !path.win32.isAbsolute(workspace) ||
          workspace.startsWith('\\\\') || !fs.statSync(workspace).isDirectory()) throw Error('INVALID_WORKSPACE');
      if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > MAX_PROMPT) throw Error('INVALID_PROMPT');
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) throw Error('INVALID_TIMEOUT');
      if (signal?.aborted) throw Error('JOB_ABORTED');
      // Reserve before async launch: a duplicate cannot race process creation.
      const pending = { launching: true };
      active.set(requestId, pending);
      // No shell; prompt is stdin, never interpolated into a command.
      // Workspace-write is the maximum permitted development mode here; do not
      // silently escalate to danger-full-access. Native supervisor is still required.
      let child;
      try { child = await supervisor.launchContained({ executable,
        args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', workspace, '-'],
        cwd: workspace }); }
      catch (error) { active.delete(requestId); throw error; }
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
        // The native supervisor must own cleanup if it cannot return a valid handle.
        active.delete(requestId);
        throw Error('CODEX_LAUNCH_FAILED');
      }
      const state = { child, closed: false, cleanup: null };
      child.once('close', () => { state.closed = true; });
      active.set(requestId, state);
      // An abort during suspended launch must never be ignored.
      if (signal?.aborted) {
        await this.terminateTree(requestId);
        throw Error('JOB_ABORTED');
      }
      let stdout = '', stderrBytes = 0, stdoutBytes = 0;
      let deadline;
      const timeoutFailure = () => { void this.terminateTree(requestId).catch(() => {}); };
      const onAbort = () => { void this.terminateTree(requestId).catch(() => {}); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await new Promise((resolve, reject) => {
          let settled = false;
          deadline = setTimeout(() => {
            timeoutFailure();
            finish(Error('CODEX_TIMEOUT'));
          }, timeoutSec * 1000);
          const finish = (err, value) => {
            if (settled) return;
            settled = true;
            if (err) reject(err); else resolve(value);
          };
          child.on('error', () => finish(Error('CODEX_PROCESS_ERROR')));
          if (signal?.aborted) { onAbort(); return finish(Error('JOB_ABORTED')); }
          child.stdout.on('data', chunk => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_OUTPUT) { void this.terminateTree(requestId).catch(() => {}); return finish(Error('CODEX_OUTPUT_LIMIT')); }
            stdout += chunk.toString('utf8');
          });
          child.stderr.on('data', chunk => {
            stderrBytes += chunk.length;
            if (stderrBytes > MAX_OUTPUT) { void this.terminateTree(requestId).catch(() => {}); finish(Error('CODEX_STDERR_LIMIT')); }
          });
          child.on('close', code => {
            if (signal?.aborted) return finish(Error('JOB_ABORTED'));
            if (code !== 0) return finish(Error('CODEX_EXIT_NONZERO'));
            let text = '';
            try {
              for (const line of stdout.split(/\r?\n/)) {
                if (!line.trim()) continue;
                const item = JSON.parse(line);
                if (item.type === 'item.completed' && item.item?.type === 'agent_message') text = item.item.text || text;
              }
            } catch { return finish(Error('INVALID_CODEX_JSONL')); }
            finish(null, { text, exitCode: code });
          });
          child.stdin.on('error', () => finish(Error('CODEX_STDIN_ERROR')));
          child.stdin.end(prompt);
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(deadline);
        // Never report a successful or failed run as complete before the native
        // supervisor confirms that the entire Job Object is empty.
        await this.terminateTree(requestId);
      }
    },
    async terminateTree(requestId) {
      const state = active.get(requestId);
      if (!state) return;
      if (state.cleanup) return state.cleanup;
      state.cleanup = (async () => {
        // Native supervisor must verify the entire Job Object is empty, even if
        // the parent already exited. Never infer descendant exit from 'close'.
        await supervisor.terminateAndVerify(state.child);
        active.delete(requestId);
      })();
      return state.cleanup;
    },
  };
}
