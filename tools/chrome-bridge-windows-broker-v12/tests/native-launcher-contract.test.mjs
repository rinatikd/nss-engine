import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const launcher = await readFile(new URL('../native/test_launcher.cpp', import.meta.url), 'utf8');
const worker = await readFile(new URL('../native/synthetic_worker.cpp', import.meta.url), 'utf8');
const plan = await readFile(new URL('../VM_TEST_PLAN.md', import.meta.url), 'utf8');

test('native prototype is compile-time gated to generated disposable-VM pins', () => {
  assert.match(launcher, /__has_include\("test_pins\.h"\)/);
  assert.match(launcher, /CHROME_BRIDGE_V12_DISPOSABLE_VM_BUILD/);
  assert.match(launcher, /TEST_PINS_HEADER_MISSING/);
  assert.match(launcher, /DISPOSABLE_VM_BUILD_FLAG_REQUIRED/);
  assert.match(launcher, /argc != 1/);
});

test('candidate identity and signer checks use a held read-only handle before process creation', () => {
  assert.match(launcher, /CreateFileW\(v12pins::kWorkerPath, GENERIC_READ, FILE_SHARE_READ/);
  assert.match(launcher, /FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.match(launcher, /nNumberOfLinks != 1/);
  assert.match(launcher, /GetFinalPathNameByHandleW/);
  assert.match(launcher, /HashHandle\(file, digest\)/);
  assert.match(launcher, /fileInfo\.hFile = file/);
  assert.match(launcher, /VerifyTrustAndPinnedLeaf/);
});

test('create-suspended launch config carries the handle allowlist, AppContainer/LPAC and Job before resume', () => {
  for (const token of [
    'PROC_THREAD_ATTRIBUTE_HANDLE_LIST', 'PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES',
    'PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY', 'PROC_THREAD_ATTRIBUTE_JOB_LIST',
    'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', 'JOB_OBJECT_LIMIT_ACTIVE_PROCESS',
    'CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT', 'ResumeThread(pi.hThread)',
  ]) assert.ok(launcher.includes(token), `missing ${token}`);
  const create = launcher.indexOf('CreateProcessW(finalPath.c_str()');
  const childCheck = launcher.indexOf('VerifyChildImage(pi.hProcess', create);
  const resume = launcher.indexOf('ResumeThread(pi.hThread)', create);
  assert.ok(create >= 0 && childCheck > create && resume > childCheck);
  assert.match(launcher, /PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT/);
  assert.match(launcher, /VerifyAppContainerToken\(token\.get\(\), profile\.sid\)/);
  assert.match(launcher, /EqualSid\(appInfo->TokenAppContainer, expectedAppContainerSid\)/);
  assert.match(launcher, /capabilities->GroupCount == 0/);
  const setJob = launcher.slice(launcher.indexOf('bool SetJobLimits'), launcher.indexOf('bool VerifyJobLimits'));
  assert.doesNotMatch(setJob, /JOB_OBJECT_LIMIT_(?:SILENT_)?BREAKAWAY_OK/);
});

test('rollback is bounded and unexpected created children are terminated before failure returns', () => {
  assert.match(launcher, /ProcessRollback/);
  assert.match(launcher, /TerminateJobObject\(job, ERROR_PROCESS_ABORTED\)/);
  assert.match(launcher, /WaitForSingleObject\(pi\.hProcess, 10000\)/);
  assert.match(launcher, /WaitForSingleObject\(pi\.hProcess, 30000\)/);
  assert.match(worker, /CREATE_SUSPENDED \| CREATE_NO_WINDOW/);
  assert.match(worker, /TerminateProcess\(pi\.hProcess/);
});

test('worker only probes synthetic environment, workspace, credentials, loopback and child creation', () => {
  for (const token of ['CB_V12_SYNTHETIC_ONLY', 'CB_WORKSPACE', 'CB_V12_SYNTHETIC_CREDENTIAL_PATH', '127.0.0.1', '--child']) {
    assert.ok((worker + launcher).includes(token), `missing ${token}`);
  }
  assert.doesNotMatch(worker, /https?:\/\//i);
  assert.doesNotMatch(worker, /CODEX_HOME\s*=/i);
});

test('VM plan describes all eight host-observed scenarios and evidence is not self-attested', () => {
  for (const heading of [
    '### 1. AppContainer', '### 2. Job limits', '### 3. DACL', '### 4. Inherited handle list',
    '### 5. OS-level network', '### 6. Synthetic credential', '### 7. Child-process escape', '### 8. Crash cleanup',
  ]) assert.ok(plan.includes(heading), `missing ${heading}`);
  assert.match(plan, /self-report|self-attest/i);
  assert.match(plan, /BLOCKED/i);
});

