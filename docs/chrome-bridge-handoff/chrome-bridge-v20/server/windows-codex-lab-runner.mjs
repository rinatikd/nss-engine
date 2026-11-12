// Experimental Windows-only Codex supervisor for a LOCAL, explicitly approved lab.
// Not connected to production MCP. Runs with the permissions of the current Windows user.
// No elevation, credential changes, firewall changes or shell invocation.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT = 1024 * 1024;
const MAX_PROMPT = 32768;

export function createWindowsCodexRunner({
  executable,
  spawnProcess = spawn,
  killTree = defaultKillTree,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') throw Error('WINDOWS_ONLY');
  if (typeof executable !== 'string' || !path.win32.isAbsolute(executable) ||
      executable.startsWith('\\\\') || !/\.exe$/i.test(executable)) throw Error('INVALID_CODEX_EXECUTABLE');
  const active = new Map();
  return {
    async run({ requestId, workspace, prompt, timeoutSec = 120, signal }) {
      if (active.has(requestId)) throw Error('RUNNER_DUPLICATE');
      if (typeof workspace !== 'string' || !path.win32.isAbsolute(workspace) ||
          workspace.startsWith('\\\\') || !fs.statSync(workspace).isDirectory()) throw Error('INVALID_WORKSPACE');
      if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > MAX_PROMPT) throw Error('INVALID_PROMPT');
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) throw Error('INVALID_TIMEOUT');
      if (signal?.aborted) throw Error('JOB_ABORTED');
      // No shell; prompt is stdin, never interpolated into a command.
      const child = spawnProcess(executable,
        ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', workspace, '-'],
        { cwd: workspace, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) throw Error('CODEX_LAUNCH_FAILED');
      const state = { child, closed: false, cleanup: null };
      child.once('close', () => { state.closed = true; });
      active.set(requestId, state);
      let stdout = '', stderrBytes = 0, stdoutBytes = 0;
      const onAbort = () => { void this.terminateTree(requestId).catch(() => {}); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await new Promise((resolve, reject) => {
          let settled = false;
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
        // Keep the entry until a confirmed cleanup; caller must also await terminateTree.
      }
    },
    async terminateTree(requestId) {
      const state = active.get(requestId);
      if (!state) return;
      if (state.cleanup) return state.cleanup;
      state.cleanup = (async () => {
        // A normal process exit does not need taskkill (which would return an error).
        // For a live parent, request termination and wait for its close event.
        if (!state.closed) {
          const closed = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('TREE_CLOSE_TIMEOUT')), 10000);
            state.child.once('close', () => { clearTimeout(timeout); resolve(); });
          });
          try { await killTree(state.child.pid); }
          catch (error) { if (!state.closed) throw error; }
          await closed;
        }
        active.delete(requestId);
      })();
      return state.cleanup;
    },
  };
}

async function defaultKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('INVALID_PID');
  // taskkill is the built-in Windows process-tree termination utility.
  // A successful return is not an OS-level guarantee against escaped descendants.
  await new Promise((resolve, reject) => {
    const p = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' });
    p.once('error', () => reject(Error('TREE_KILL_FAILED')));
    p.once('close', code => code === 0 ? resolve() : reject(Error('TREE_KILL_UNCONFIRMED')));
  });
}
