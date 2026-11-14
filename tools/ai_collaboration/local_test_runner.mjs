// Structured local test task runner. No arbitrary command or shell string is accepted.
// This is a standalone runner, NOT yet wired to PowerShell Direct MCP.
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const SUITES = Object.freeze({
  'platform-contract': {
    command: 'python',
    args: ['-m', 'unittest', 'discover', '-s', 'tools/ai_collaboration', '-p', 'test_*.py', '-v'],
    cwd: '.',
    timeoutMs: 60000
  },
  'nss-portable': {
    command: 'python',
    args: ['tools/run_portable_checks.py'],
    cwd: '.',
    timeoutMs: 180000
  },
  'platform-node': {
    command: 'node',
    args: ['--test', 'tools/ai_collaboration/*.test.mjs'],
    cwd: '.',
    timeoutMs: 60000
  }
});

const MAX_OUTPUT = 64 * 1024;
const REQUEST = /^[a-zA-Z0-9_-]{8,80}$/;
export class TaskPolicyError extends Error {}

export async function resolveTestPlan({ requestId, suite, workspace, approved, approvedRequestId }, workspaceAllowlist) {
  if (typeof requestId !== 'string' || !REQUEST.test(requestId))
    throw new TaskPolicyError('INVALID_REQUEST_ID');
  if (approved !== true || approvedRequestId !== requestId)
    throw new TaskPolicyError('EXPLICIT_APPROVAL_REQUIRED');
  if (typeof suite !== 'string' || !Object.hasOwn(SUITES, suite))
    throw new TaskPolicyError('UNKNOWN_TEST_SUITE');
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace))
    throw new TaskPolicyError('INVALID_WORKSPACE');
  const candidate = await realpath(workspace);
  if (!(await stat(candidate)).isDirectory())
    throw new TaskPolicyError('NOT_A_DIRECTORY');
  const roots = await Promise.all(workspaceAllowlist.map(root => realpath(root)));
  if (!roots.includes(candidate))
    throw new TaskPolicyError('WORKSPACE_NOT_ALLOWLISTED');
  const spec = SUITES[suite];
  return Object.freeze({
    requestId, suite, command: spec.command,
    args: Object.freeze([...spec.args]), cwd: candidate,
    timeoutMs: spec.timeoutMs
  });
}

// IMPORTANT: the MCP server must persist a one-shot durable claim *before*
// calling executeTestPlan. This standalone function does not implement replay
// protection, user authorization, or an OS sandbox.
export async function executeTestPlan(plan, { spawnImpl = spawn } = {}) {
  if (!plan || !Object.hasOwn(SUITES, plan.suite))
    throw new TaskPolicyError('UNRECOGNIZED_PLAN');
  const spec = SUITES[plan.suite];
  if (plan.command !== spec.command ||
      JSON.stringify(plan.args) !== JSON.stringify(spec.args) ||
      plan.timeoutMs !== spec.timeoutMs)
    throw new TaskPolicyError('PLAN_MODIFIED');
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(plan.command, plan.args, {
        cwd: plan.cwd, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
          PYTHONDONTWRITEBYTECODE: '1'
        }
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '', stderr = '', truncated = false, settled = false;
    const append = (current, chunk) => {
      const room = MAX_OUTPUT - Buffer.byteLength(current, 'utf8');
      if (room <= 0) { truncated = true; return current; }
      if (chunk.length > room) truncated = true;
      return current + chunk.subarray(0, room).toString('utf8');
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, plan.timeoutMs);
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      resolve({ requestId: plan.requestId, suite: plan.suite,
                exitCode, signal, stdout, stderr, truncated });
    });
  });
}
