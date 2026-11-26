import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = relative => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const roots = read('tools/powershell-direct/Inspect-PR102LabRoots.ps1');
const runtime = read('tools/powershell-direct/Inspect-PR102LabRuntime.ps1');
const probe = read('tools/powershell-direct/Probe-PR102AgentAdapters.ps1');
const preCutover = read('tools/powershell-direct/Prepare-PR145LabPort17485.ps1');
const updater = read('docs/chrome-bridge-handoff/chrome-bridge-v20/deployment/upgrade-pr102-lab.ps1');

test('current PR102 inventory scripts target the dedicated 17485 StateRoot', () => {
  for (const [name, source] of [['roots', roots], ['runtime', runtime], ['adapter probe', probe]]) {
    assert.match(source, /ChromeBridge-PR102-17485-State/, name);
    assert.doesNotMatch(source, /ChromeBridge-PR102-17484-State/, name);
  }
  assert.match(updater, /ChromeBridge-PR102-17485-State/);
  assert.match(roots, /nhflbnfcaicihaepdcjacdmaddagcmcj/);
  assert.match(runtime, /nhflbnfcaicihaepdcjacdmaddagcmcj/);
});

test('legacy extension directory label is not confused with its 17485 endpoint', () => {
  assert.match(roots, /Legacy directory label; endpoint is 17485/);
  assert.match(runtime, /Legacy directory label; endpoint is 17485/);
  assert.match(roots, /http:\/\/127\.0\.0\.1:17485\/\*/);
  assert.match(roots, /ManifestExtensionIdMatchesExpected/);
  assert.match(roots, /ExtensionRootAcl/);
  assert.match(roots, /StateRootAcl/);
  assert.match(runtime, /StateRootMatchesExpected/);
  assert.match(runtime, /ExtensionRootAcl/);
  assert.match(runtime, /StateRootAcl/);
});

test('PR102 adapter probe remains read-only and does not pin the obsolete 17484 config hash', () => {
  assert.match(probe, /tools\/list/);
  assert.match(probe, /agent_list/);
  assert.match(probe, /agent_selftest/);
  assert.doesNotMatch(probe, /provider_commit|provider_send/);
  assert.match(probe, /configHashBefore/);
  assert.doesNotMatch(probe, /configExpectedSha/);
  assert.match(probe, /MessagesSent=0/);
  assert.match(probe, /GrantsChanged=\$false/);
});

test('PR145 17485 preparation remains explicitly pre-cutover for the old 17484 state', () => {
  assert.match(preCutover, /PRE-CUTOVER ONLY/);
  assert.match(preCutover, /ChromeBridge-PR102-17484-State/);
  assert.match(preCutover, /Consilium 17484/);
});
