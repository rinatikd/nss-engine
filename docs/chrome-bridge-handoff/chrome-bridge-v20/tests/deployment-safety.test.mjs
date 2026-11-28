import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const restore = fs.readFileSync(path.join(root, 'deployment/upgrade-windows.ps1'), 'utf8');
const verifier = fs.readFileSync(path.join(root, 'deployment/verify-rollback.mjs'), 'utf8');

test('Windows Restore requires explicit confirmation and an explicitly selected disposable target', () => {
  assert.match(restore, /PSBoundParameters\.ContainsKey\('BridgeRoot'\)/);
  assert.match(restore, /if \(-not \$ConfirmRestore\)/);
  assert.match(restore, /CHROME_BRIDGE_DISPOSABLE_RESTORE_V1/);
  assert.match(restore, /GetTempPath\(\)/);
  assert.match(restore, /direct child of the OS temp directory/);
  assert.match(restore, /ReparsePoint/);
  assert.match(restore, /Production BridgeRoot is forbidden/);
  assert.match(restore, /No Restore command emitted/);
  assert.doesNotMatch(restore, /Request accepted: copy of backup/);
});

test('rollback verifier is synthetic-only and contains no Production credential or endpoint references', () => {
  assert.match(verifier, /SYNTHETIC_TEMP_STATE_ONLY/);
  assert.match(verifier, /synthetic-rollback-agent-token-only/);
  assert.match(verifier, /CHROME_BRIDGE_HOME = state/);
  assert.match(verifier, /CHROME_BRIDGE_PORT = '0'/);
  assert.doesNotMatch(verifier, /\.chrome-bridge/i);
  assert.doesNotMatch(verifier, /17381|17382/);
  assert.doesNotMatch(verifier, /productionState|realConfig|protectedHashes/i);
  assert.doesNotMatch(verifier, /os\.homedir\(\)/);
});
