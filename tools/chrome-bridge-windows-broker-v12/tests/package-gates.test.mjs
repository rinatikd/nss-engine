import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const policy = await readFile(new URL('../policy.mjs', import.meta.url), 'utf8');
const schema = await readFile(new URL('../attestation.schema.json.in', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
const plan = await readFile(new URL('../VM_TEST_PLAN.md', import.meta.url), 'utf8');
const syntheticProbe = await readFile(new URL('./Run-SyntheticVmProbe.ps1', import.meta.url), 'utf8');
const syntheticWorkflow = await readFile(new URL('../native-synthetic-probe-workflow.yml', import.meta.url), 'utf8');

test('v2 claim schema is valid JSON and explicitly describes untrusted claims', () => {
  const parsed = JSON.parse(schema);
  assert.equal(parsed.properties.protocol.const, 2);
  assert.match(parsed.title, /untrusted until controller-signed/);
  assert.ok(parsed.properties.evidence.properties.job.required.includes('breakawayDisabled'));
});

test('source-only workflow is manual, read-only, and cannot compile or run broker images', () => {
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /node --test/);
  assert.doesNotMatch(workflow, /\b(cl\.exe|CreateProcessW|ResumeThread|broker\.exe|worker\.exe|image_inspector\.exe|Start-Process)\b/i);
});

test('JS trust boundary never upgrades JSON claims to host or execution authority', () => {
  assert.match(policy, /NATIVE_HANDLE_VERIFIER_NOT_LINKED/);
  assert.match(policy, /NATIVE_HANDLE_ACL_PROVIDER_REQUIRED/);
  assert.match(policy, /hostOriginVerified: false, osIsolationProven: false, executionAuthorized: false/);
  assert.doesNotMatch(policy, /function verifyPinnedImage\(\s*\{[^}]*signature/);
});

test('VM plan contains exactly the required eight scenario headings and evidence failures block', () => {
  for (const title of [
    '### 1. AppContainer', '### 2. Job limits', '### 3. DACL', '### 4. Inherited handle',
    '### 5. OS-level network', '### 6. Synthetic credential', '### 7. Child-process escape', '### 8. Crash cleanup',
  ]) assert.ok(plan.includes(title), `missing ${title}`);
  assert.match(plan, /Any missing measurement.*yields \*\*BLOCKED\/FAIL\*\*/);
});

test('synthetic hosted probe bounds compiler and whole-step hangs and never targets Codex', () => {
  assert.match(syntheticProbe, /WaitForExit\(\$TimeoutSec \* 1000\)/);
  assert.match(syntheticProbe, /\$process\.Kill\(\$true\)/);
  assert.match(syntheticProbe, /WORKER_COMPILE/);
  assert.match(syntheticProbe, /LAUNCHER_COMPILE/);
  assert.doesNotMatch(syntheticProbe, /RedirectStandard(?:Output|Error)|ReadToEndAsync/);
  assert.match(syntheticProbe, /vctip child can outlive cl\.exe/);
  assert.match(syntheticWorkflow, /timeout-minutes:\s*12/);
  assert.match(syntheticWorkflow, /Enter-VsDevShell/);
  assert.match(syntheticWorkflow, /& \$probeScript -DisposableVmAcknowledged/);
  assert.doesNotMatch(syntheticWorkflow, /\$env:ComSpec|WaitForExit\(600000\)/);
  assert.doesNotMatch(syntheticProbe, /\$env:(?:TEMP|TMP)\s*=\s*\$tempRoot/);
  assert.doesNotMatch(syntheticProbe, /codex\.exe|codex\.cmd|CODEX_HOME|OPENAI_API_KEY/i);
});

