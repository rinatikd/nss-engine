// Structured local test task runner. No arbitrary command or shell string is accepted.
// This is a standalone runner, NOT yet wired to PowerShell Direct MCP.
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import fs from 'node:fs';
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
    args: ['--test', 'tools/ai_collaboration/local_test_runner.test.mjs',
      'tools/ai_collaboration/chat-approval-attestation.test.mjs',
      'tools/ai_collaboration/chat-approval-redemption.test.mjs',
      'tools/ai_collaboration/chat-approval-replay-store.test.mjs',
      'tools/ai_collaboration/chat-approval-service.test.mjs',
      'tools/powershell-direct/tests/chat-approval-config.test.mjs',
      'tools/ai_collaboration/local_job_service.test.mjs',
      'tools/ai_collaboration/local_mcp_dispatch.test.mjs',
      'tools/powershell-direct/tests/service.test.mjs',
      'tools/powershell-direct/tests/named-suites.test.mjs',
      'tools/powershell-direct/tests/engineering.test.mjs',
      'tools/ai_collaboration/engineering-runner.test.mjs',
      'tools/ai_collaboration/recovery/recovery-plan.test.mjs',
      'tools/ai_collaboration/recovery/recovery-runtime.test.mjs',
      'tools/ai_collaboration/recovery/recovery-journal.test.mjs',
      'tools/ai_collaboration/recovery/windows-recovery-contract.test.mjs',
      'tools/ai_collaboration/recovery/native-host-contract.test.mjs'],
    cwd: '.',
    timeoutMs: 120000
  },
  // Execute only in a separately approved PR113 checkout. Tests may create
  // caches; neither these suites nor their outputs are "read-only".
  'chrome-pr113-node': {
    command: 'node',
    args: ['--test', 'docs/chrome-bridge-handoff/chrome-bridge-v20/tests/one-click-session.test.mjs'],
    cwd: '.',
    timeoutMs: 120000
  },
  'chrome-pr113-build-lab17484': {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-File',
      'docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/Build-OneClick-Lab.ps1',
      '-LabPort', '17484', '-OutputRoot',
      'C:\\Engineering\\ChromeBridge-PR113-E2E-Build-v4'],
    cwd: '.',
    timeoutMs: 120000
  }
});

// Production Windows command lookup must not traverse PATH or a repository.
// Python suites are disabled until an operator pins an absolute trusted Python
// executable in PS_DIRECT_TRUSTED_PYTHON.
const WINDOWS_BINARIES = Object.freeze({
  node:'C:\\Program Files\\nodejs\\node.exe',
  'powershell.exe':'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
});
export function trustedExecutable(command,{
  platform=process.platform, pythonPath=process.env.PS_DIRECT_TRUSTED_PYTHON
}={}) {
  if(platform!=='win32') return command; // portable mock/unit tests only
  const exe=command==='python'?pythonPath:WINDOWS_BINARIES[command];
  if(typeof exe!=='string'||!path.win32.isAbsolute(exe)||
     exe.startsWith('\\\\')||!fs.existsSync(exe)||
     !fs.statSync(exe).isFile()||
     fs.realpathSync.native(exe).toLowerCase()!==path.win32.normalize(exe).toLowerCase())
    throw new TaskPolicyError('TRUSTED_EXECUTABLE_NOT_CONFIGURED');
  return exe;
}

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

// Windows child processes can spawn grandchildren (Node -> PowerShell -> tests).
// A direct child.kill() does not guarantee cleanup of the tree. Use a fixed,
// non-shell taskkill invocation for a specific known child PID.
export function terminateProcessTree(child, {
  platform = process.platform, spawnImpl = spawn
} = {}) {
  const fallback=()=>{ try { child?.kill('SIGKILL'); } catch {} };
  if (platform !== 'win32' || !Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    fallback(); return 'direct';
  }
  try {
    const killer=spawnImpl('taskkill.exe',
      ['/PID',String(child.pid),'/T','/F'],
      {shell:false,windowsHide:true,stdio:'ignore'});
    killer.on('error',fallback);
    killer.on('close',code=>{ if(code!==0) fallback(); });
    return 'tree';
  } catch {
    fallback(); return 'fallback';
  }
}

// IMPORTANT: the MCP server must persist a one-shot durable claim *before*
// calling executeTestPlan. This standalone function does not implement replay
// protection, user authorization, or an OS sandbox.
export async function executeTestPlan(plan, { spawnImpl = spawn, terminateImpl = terminateProcessTree } = {}) {
  if (!plan || !Object.hasOwn(SUITES, plan.suite))
    throw new TaskPolicyError('UNRECOGNIZED_PLAN');
  const spec = SUITES[plan.suite];
  if (plan.command !== spec.command ||
      JSON.stringify(plan.args) !== JSON.stringify(spec.args) ||
      plan.timeoutMs !== spec.timeoutMs)
    throw new TaskPolicyError('PLAN_MODIFIED');
  const executable=trustedExecutable(plan.command);
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, plan.args, {
        cwd: plan.cwd, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: {
          PATH: process.platform==='win32'
            ? 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;C:\\Program Files\\dotnet'
            : (process.env.PATH ?? ''),
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
          PYTHONDONTWRITEBYTECODE: '1',
          GIT_TERMINAL_PROMPT:'0',
          CI:'1'
        }
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '', stderr = '', truncated = false, settled = false, timedOut = false;
    let killWatchdog = null;
    const append = (current, chunk) => {
      const room = MAX_OUTPUT - Buffer.byteLength(current, 'utf8');
      if (room <= 0) { truncated = true; return current; }
      if (chunk.length > room) truncated = true;
      return current + chunk.subarray(0, room).toString('utf8');
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      try { terminateImpl(child); } catch { try { child.kill('SIGKILL'); } catch {} }
      // If the process tree does not report closure, do not hang forever or
      // falsely report successful termination. A retry is still forbidden.
      killWatchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({requestId:plan.requestId,suite:plan.suite,exitCode:null,
          signal:null,stdout,stderr,truncated,timedOut:true,
          terminationUnconfirmed:true});
      },5000);
    }, plan.timeoutMs);
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timeout); clearTimeout(killWatchdog); reject(error); } });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearTimeout(killWatchdog);
      resolve({ requestId: plan.requestId, suite: plan.suite,
                exitCode, signal, stdout, stderr, truncated, timedOut,
                terminationUnconfirmed:false });
    });
  });
}
