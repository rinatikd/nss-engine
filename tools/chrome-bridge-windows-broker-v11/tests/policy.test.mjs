import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseBrokerPolicy, validateWindowsPathSyntax, verifyPinnedImage, validateProtectedAcl,
  createChallenge, ChallengeLedger, validateAttestationShape,
} from '../policy.mjs';

const digest = 'a'.repeat(64);
function makePolicy(overrides = {}) {
  return {
    schemaVersion: 1, enabled: false,
    broker: { path: 'C:\\Program Files\\ChromeBridge\\broker.exe', sha256: digest, signerCertificateSha256: 'b'.repeat(64), version: '1.0.0' },
    codex: { path: 'C:\\Program Files\\OpenAI\\Codex\\bin\\codex.exe', sha256: 'c'.repeat(64), signerCertificateSha256: 'd'.repeat(64), version: 'codex-cli/0.164.0' },
    workspaces: { source: { path: 'C:\\ChromeBridge\\workspaces\\source', access: 'read-only' } },
    approval: { perJobLocalConfirmation: true, dangerousActions: 'deny' },
    limits: { timeoutSeconds: 120, maxOutputBytes: 262144, maxProcesses: 1, maxMemoryBytes: 134217728 },
    ...overrides,
  };
}
function challenge() {
  return createChallenge({ policySha256: digest, brokerSha256: 'b'.repeat(64), codexSha256: 'c'.repeat(64), workspaceId: 'source' });
}
function report(expected) {
  return {
    protocol: 2, ...expected,
    evidence: {
      appContainer: { enabled: true, sid: 'S-1-15-2-10-20', lowPrivilege: true, lpac: true, capabilitySids: [] },
      network: { outboundAllowed: false, denialProbePassed: true },
      credentials: { profileReadDenied: true, codexHomeReadDenied: true, syntheticCredentialReadDenied: true },
      workspace: { pathSha256: 'f'.repeat(64), readOnly: true, writeProbeDenied: true },
      handles: ['stdin', 'stdout', 'stderr'], environment: ['SystemRoot', 'TEMP', 'TMP'],
      job: { killOnClose: true, activeProcessLimit: 1, breakawayDisabled: true, childProcessRestricted: true, memoryLimitBytes: 134217728, cpuTimeLimit100ns: 1000000, descendantsEmptyAfterCrash: true },
      cleanup: { fixtureRemoved: true, handlesClosed: true, childTerminated: true },
    },
  };
}

test('strict JSON-only policy accepts valid non-placeholder pins, remains disabled, and is deeply immutable', () => {
  const parsed = parseBrokerPolicy(JSON.stringify(makePolicy()));
  assert.equal(parsed.enabled, false);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.broker));
  assert.equal(parsed.broker.signerCertificateSha256, 'b'.repeat(64));
  assert.throws(() => { parsed.enabled = true; }, TypeError);
});

test('policy rejects activation, unknown keys, old signer field, zero pins and unbounded values', () => {
  assert.throws(() => parseBrokerPolicy(JSON.stringify(makePolicy({ enabled: true }))), /ACTIVATION_NOT_ATTESTED/);
  assert.throws(() => parseBrokerPolicy(JSON.stringify({ ...makePolicy(), module: './policy.mjs' })), /POLICY_KEYS_INVALID/);
  assert.throws(() => parseBrokerPolicy(JSON.stringify(makePolicy({ broker: { ...makePolicy().broker, sha256: '0'.repeat(64) } }))), /BROKER_PIN_INVALID/);
  const oldShape = makePolicy(); oldShape.broker.signerThumbprint = '1'.repeat(40);
  assert.throws(() => parseBrokerPolicy(JSON.stringify(oldShape)), /POLICY_KEYS_INVALID/);
  assert.throws(() => parseBrokerPolicy('x'.repeat(65537)), /POLICY_SIZE_INVALID/);
});

test('Windows image and workspace pins reject unsafe path syntax without claiming filesystem identity', () => {
  assert.equal(validateWindowsPathSyntax('C:\\trusted\\bin\\broker.exe', { executable: true }), 'C:\\trusted\\bin\\broker.exe');
  for (const p of ['relative.exe', '\\\\server\\share\\x.exe', '\\\\?\\C:\\x.exe', 'C:\\x.exe:stream', 'C:\\bad.\\x.exe', 'C:\\CON\\file', 'C:\\x.exe\0']) {
    assert.throws(() => validateWindowsPathSyntax(p, { executable: true }));
  }
  assert.throws(() => parseBrokerPolicy(JSON.stringify(makePolicy({ broker: { ...makePolicy().broker, version: 'UNPINNED-EXAMPLE' } }))), /BROKER_VERSION_INVALID/);
});

test('caller-supplied signature, bytes and ACL snapshots never cross the Windows trust boundary', () => {
  assert.throws(() => verifyPinnedImage({ filePath: 'C:\\x.exe', expected: makePolicy().broker, bytes: Buffer.from('x'), signature: { status: 'Valid' } }), /NATIVE_HANDLE_VERIFIER_NOT_LINKED/);
  assert.throws(() => validateProtectedAcl({ ownerSid: 'S-1-5-18', daclProtected: true, aces: [] }), /NATIVE_HANDLE_ACL_PROVIDER_REQUIRED/);
  assert.throws(() => verifyPinnedImage({ signature: { status: 'Valid', signerCertificateSha256: 'a'.repeat(64) } }), /NATIVE_HANDLE_VERIFIER_NOT_LINKED/);
});

test('example file is deliberately non-runnable and rejects placeholder pins', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../policy.example.json.in', import.meta.url), 'utf8'));
  assert.equal(example.enabled, false);
  assert.throws(() => parseBrokerPolicy(JSON.stringify(example)), /BROKER_PIN_INVALID/);
});

test('nonce challenge is copied, frozen, fully bound, single-use, and failure consumes it', () => {
  const ledger = new ChallengeLedger({ ttlMs: 5_000, maxOutstanding: 4 });
  const input = challenge();
  const issued = ledger.issue(input);
  assert.equal(issued.workspaceId, 'source');
  assert.throws(() => { input.workspaceId = 'changed'; }, TypeError);
  assert.throws(() => { issued.workspaceId = 'changed'; }, TypeError);
  const good = report(issued);
  assert.deepEqual(ledger.consume(good), { contractShapeValid: true, hostOriginVerified: false, osIsolationProven: false, executionAuthorized: false });
  assert.equal(ledger.size, 0);
  assert.throws(() => ledger.consume(good), /CHALLENGE_UNKNOWN_OR_REPLAYED/);
  const next = ledger.issue(challenge());
  const bad = report(next); bad.workspaceId = 'other';
  assert.throws(() => ledger.consume(bad), /ATTESTATION_BINDING_MISMATCH/);
  assert.equal(ledger.size, 0);
  assert.throws(() => ledger.consume(bad), /CHALLENGE_UNKNOWN_OR_REPLAYED/);
});

test('nonce ledger enforces bounded capacity and TTL, purges expired entries, and clears on restart', async () => {
  const ledger = new ChallengeLedger({ ttlMs: 1_000, maxOutstanding: 1 });
  const authored = challenge();
  const expired = ledger.issue(authored);
  assert.throws(() => ledger.issue(authored), /CHALLENGE_REPLAY/);
  assert.throws(() => ledger.issue(challenge()), /CHALLENGE_LEDGER_FULL/);
  await new Promise(resolve => setTimeout(resolve, 1_050));
  assert.throws(() => ledger.consume(report(expired)), /CHALLENGE_EXPIRED/);
  assert.equal(ledger.size, 0);
  const final = ledger.issue(challenge());
  ledger.clear();
  assert.throws(() => ledger.consume(report(final)), /CHALLENGE_UNKNOWN_OR_REPLAYED/);
  assert.throws(() => new ChallengeLedger({ ttlMs: Infinity }), /CHALLENGE_LEDGER_CONFIG_INVALID/);
  assert.throws(() => new ChallengeLedger({ now: () => 0 }), /POLICY_KEYS_INVALID/);
});

test('attestation schema checks only shape; fake JSON cannot establish host origin or execution authority', () => {
  const expected = challenge();
  assert.deepEqual(validateAttestationShape(report(expected), expected), { contractShapeValid: true, hostOriginVerified: false, osIsolationProven: false, executionAuthorized: false });
  const altered = report(expected); altered.evidence.job.breakawayDisabled = false;
  assert.throws(() => validateAttestationShape(altered, expected), /ATTESTATION_JOB_SHAPE_INVALID/);
});
