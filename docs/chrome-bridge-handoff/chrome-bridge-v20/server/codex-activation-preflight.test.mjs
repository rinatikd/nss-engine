import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCodexActivation } from './codex-activation-preflight.mjs';

test('unconfigured runtime reports disabled without revealing paths', () => {
  const r = inspectCodexActivation({ policyPath: '', runtimeFile: '/nonexistent/source' });
  assert.equal(r.policyConfigured, false);
  assert.equal(r.activation, 'disabled');
  assert.equal(r.runtimeGate, 'source-unavailable');
  assert.equal(JSON.stringify(r).includes('nonexistent'), false);
});
test('invalid policy candidate is classified but never imported', () => {
  const r = inspectCodexActivation({ policyPath: '../candidate.js', runtimeFile: '/nonexistent/source' });
  assert.equal(r.policyPathShape, 'invalid');
  assert.equal(r.activation, 'disabled');
});
test('source-level unconditional reject is identified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-codex-preflight-'));
  try {
    const file = join(dir, 'runtime.mjs');
    writeFileSync(file, "throw Error('CODEX_ISOLATION_UNAVAILABLE');");
    const r = inspectCodexActivation({ policyPath: '', runtimeFile: file });
    assert.equal(r.runtimeGate, 'unconditional-reject-in-source');
    assert.equal(r.nextAction, 'implement-trusted-native-runner');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
