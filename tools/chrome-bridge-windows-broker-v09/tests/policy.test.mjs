import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBrokerPolicy, canonicalLocalPath, verifyPinnedImage, validateProtectedAcl,
  createChallenge, ChallengeLedger, validateAttestation,
} from '../policy.mjs';

const hash = 'a'.repeat(64), thumb = 'b'.repeat(40);
function policy(overrides = {}) {
  return {
    schemaVersion: 1, enabled: false,
    broker: { path: 'C:\\Program Files\\ChromeBridge\\broker.exe', sha256: hash, signerThumbprint: thumb, version: '1.0' },
    codex: { path: 'C:\\Program Files\\OpenAI\\Codex\\bin\\codex.exe', sha256: hash, signerThumbprint: thumb, version: 'codex-cli 0.164.0' },
    workspaces: { source: { path: 'C:\\ChromeBridge\\workspaces\\source', access: 'read-only' } },
    approval: { perJobLocalConfirmation: true, dangerousActions: 'deny' },
    limits: { timeoutSeconds: 120, maxOutputBytes: 262144, maxProcesses: 1, maxMemoryBytes: 134217728 },
    ...overrides,
  };
}

test('strict data-only allowlist parses and stays disabled', () => {
  const parsed = parseBrokerPolicy(JSON.stringify(policy()));
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.workspaces.source.access, 'read-only');
});

test('checked-in example is strict data only and explicitly non-activating', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../policy.example.json.in', import.meta.url), 'utf8'));
  const parsed = parseBrokerPolicy(JSON.stringify(example));
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.broker.sha256, '0'.repeat(64));
  assert.equal(parsed.codex.sha256, '0'.repeat(64));
});

test('activation, unknown keys, bad workspace IDs, and unsafe access fail closed', () => {
  assert.throws(() => parseBrokerPolicy(JSON.stringify(policy({ enabled: true }))), /ACTIVATION_NOT_ATTESTED/);
  assert.throws(() => parseBrokerPolicy(JSON.stringify({ ...policy(), module: './policy.mjs' })), /POLICY_KEYS_INVALID/);
  assert.throws(() => parseBrokerPolicy(JSON.stringify(policy({ workspaces: { '../escape': { path: 'C:\\x', access: 'read-only' } } }))), /WORKSPACE_MAP_INVALID/);
  assert.throws(() => parseBrokerPolicy(JSON.stringify(policy({ workspaces: { source: { path: 'C:\\x', access: 'read-write' } } }))), /WORKSPACE_POLICY_INVALID/);
  assert.throws(() => parseBrokerPolicy('x'.repeat(65537)), /POLICY_SIZE_INVALID/);
});

test('executable pins require absolute native executable paths and fixed hash/signature data', () => {
  assert.throws(() => parseBrokerPolicy(JSON.stringify(policy({ codex: { ...policy().codex, sha256: '0' } }))), /CODEX_PIN_INVALID/);
  assert.throws(() => parseBrokerPolicy(JSON.stringify(policy({ broker: { ...policy().broker, path: 'relative.exe' } }))), /BROKER_PATH_INVALID/);
  assert.throws(() => parseBrokerPolicy(JSON.stringify(policy({ broker: { ...policy().broker, path: 'C:\\broker.dll' } }))), /NATIVE_EXECUTABLE_REQUIRED/);
});

test('absolute path checks deny UNC, device, ADS, control and relative paths', () => {
  for (const p of ['relative', '\\\\server\\share\\x', '\\\\?\\C:\\x', 'C:\\x:stream', 'C:\\x\0y']) {
    assert.throws(() => canonicalLocalPath(p, { directory: false }), /POLICY_PATH_INVALID/);
  }
});

test('Windows path walk rejects reparse points and hardlinked executable files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-v09-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'tool.exe'), alias = path.join(root, 'alias.exe');
  fs.writeFileSync(original, 'synthetic only'); fs.linkSync(original, alias);
  assert.throws(() => canonicalLocalPath(alias, { directory: false }), /POLICY_HARDLINK_DENIED/);
  const link = path.join(root, 'link.exe');
  try { fs.symlinkSync(original, link, 'file'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`symlink creation unavailable: ${e.code}`); throw e; }
  assert.throws(() => canonicalLocalPath(link, { directory: false }), /POLICY_REPARSE_POINT_DENIED/);
});

test('hash and Authenticode pin fail on tamper, signer mismatch, and path substitution', () => {
  const bytes = Buffer.from('synthetic executable bytes');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const expected = { path: 'C:\\fixture\\broker.exe', sha256: digest, signerThumbprint: thumb };
  const signature = { status: 'Valid', signerThumbprint: thumb };
  assert.deepEqual(verifyPinnedImage({ filePath: expected.path, expected, bytes, signature }), { hashMatches: true, signatureMatches: true, executableStarted: false });
  assert.throws(() => verifyPinnedImage({ filePath: expected.path, expected, bytes: Buffer.from('changed'), signature }), /IMAGE_HASH_MISMATCH/);
  assert.throws(() => verifyPinnedImage({ filePath: expected.path, expected, bytes, signature: { status: 'Valid', signerThumbprint: 'c'.repeat(40) } }), /IMAGE_SIGNATURE_UNVERIFIED/);
  assert.throws(() => verifyPinnedImage({ filePath: 'C:\\other\\broker.exe', expected, bytes, signature }), /IMAGE_PATH_MISMATCH/);
});

test('ACL snapshot rejects inherited ACLs, broad principals, and service write access', () => {
  const ids = { ownerSid: 'S-1-5-21-1-2-3-1000', serviceSid: 'S-1-5-80-123' };
  const snapshot = { ownerSid: ids.ownerSid, daclProtected: true, aces: [
    { sid: ids.ownerSid, access: 'full-control', type: 'allow', inherited: false },
    { sid: 'S-1-5-18', access: 'full-control', type: 'allow', inherited: false },
    { sid: ids.serviceSid, access: 'read-execute', type: 'allow', inherited: false },
  ] };
  assert.equal(validateProtectedAcl(snapshot, ids).aclShapeValid, true);
  assert.throws(() => validateProtectedAcl({ ...snapshot, daclProtected: false }, ids), /POLICY_ACL_UNPROTECTED/);
  assert.throws(() => validateProtectedAcl({ ...snapshot, aces: [...snapshot.aces, { sid: 'S-1-1-0', access: 'read', type: 'allow', inherited: false }] }, ids), /POLICY_ACL_PRINCIPAL_DENIED/);
  assert.throws(() => validateProtectedAcl({ ...snapshot, aces: snapshot.aces.map(x => x.sid === ids.serviceSid ? { ...x, access: 'full-control' } : x) }, ids), /POLICY_ACL_SERVICE_WRITE_DENIED/);
});

function evidence(expected) {
  return {
    protocol: 1, ...expected,
    evidence: {
      appContainer: { enabled: true, sid: 'S-1-15-2-1-2-3', lowPrivilege: true, lpac: true, capabilitySids: [] },
      network: { outboundAllowed: false, denialProbePassed: true },
      credentials: { profileReadDenied: true, codexHomeReadDenied: true, syntheticCredentialReadDenied: true },
      workspace: { pathSha256: hash, readOnly: true, writeProbeDenied: true },
      handles: ['stdin', 'stdout', 'stderr'], environment: ['SystemRoot', 'TEMP', 'TMP'],
      job: { killOnClose: true, activeProcessLimit: 1, childProcessRestricted: true, memoryLimitBytes: 134217728, cpuTimeLimit100ns: 1000000, descendantsEmptyAfterCrash: true },
      cleanup: { fixtureRemoved: true, handlesClosed: true },
    },
  };
}

test('complete synthetic attestation contract is shape-valid but never authorizes execution', () => {
  const challenge = createChallenge({ nonce: 'd'.repeat(64), policySha256: hash, brokerSha256: hash, codexSha256: hash, workspaceId: 'source' });
  const result = validateAttestation(evidence(challenge), challenge, () => true);
  assert.deepEqual(result, { contractShapeValid: true, osIsolationProven: false, executionAuthorized: false });
  assert.throws(() => validateAttestation(evidence(challenge), challenge, () => false), /BROKER_TRUST_UNVERIFIED/);
});

test('nonce, policy, executable and workspace binding mismatches are rejected', () => {
  const challenge = createChallenge({ nonce: 'e'.repeat(64), policySha256: hash, brokerSha256: hash, codexSha256: hash, workspaceId: 'source' });
  const changed = evidence(challenge); changed.workspaceId = 'other';
  assert.throws(() => validateAttestation(changed, challenge, () => true), /ATTESTATION_BINDING_MISMATCH/);
});

test('attestation negative cases deny weak appcontainer, ACL-equivalent, network, credentials, handles, env, job and cleanup claims', () => {
  const challenge = createChallenge({ nonce: 'f'.repeat(64), policySha256: hash, brokerSha256: hash, codexSha256: hash, workspaceId: 'source' });
  const mutations = [
    [e => { e.appContainer.capabilitySids = ['S-1-15-3-1']; }, /ATTESTATION_APPCONTAINER_INCOMPLETE/],
    [e => { e.network.outboundAllowed = true; }, /ATTESTATION_NETWORK_INCOMPLETE/],
    [e => { e.credentials.codexHomeReadDenied = false; }, /ATTESTATION_CREDENTIAL_ISOLATION_INCOMPLETE/],
    [e => { e.workspace.writeProbeDenied = false; }, /ATTESTATION_WORKSPACE_INCOMPLETE/],
    [e => { e.handles.push('inherited-secret-handle'); }, /ATTESTATION_HANDLE_ALLOWLIST_INVALID/],
    [e => { e.environment.push('CODEX_HOME'); }, /ATTESTATION_ENV_ALLOWLIST_INVALID/],
    [e => { e.job.childProcessRestricted = false; }, /ATTESTATION_JOB_INCOMPLETE/],
    [e => { e.job.descendantsEmptyAfterCrash = false; }, /ATTESTATION_JOB_INCOMPLETE/],
    [e => { e.cleanup.fixtureRemoved = false; }, /ATTESTATION_CLEANUP_INCOMPLETE/],
  ];
  for (const [mutate, error] of mutations) {
    const candidate = evidence(challenge); mutate(candidate.evidence);
    assert.throws(() => validateAttestation(candidate, challenge, () => true), error);
  }
});

test('challenge ledger consumes once and rejects replay and expiry', () => {
  let now = 100;
  const ledger = new ChallengeLedger({ ttlMs: 10, now: () => now });
  const challenge = createChallenge({ nonce: '1'.repeat(64), policySha256: hash, brokerSha256: hash, codexSha256: hash, workspaceId: 'source' });
  ledger.issue(challenge);
  assert.equal(ledger.consume(evidence(challenge), () => true).executionAuthorized, false);
  assert.throws(() => ledger.consume(evidence(challenge), () => true), /CHALLENGE_UNKNOWN_OR_REPLAYED/);
  const expired = createChallenge({ nonce: '2'.repeat(64), policySha256: hash, brokerSha256: hash, codexSha256: hash, workspaceId: 'source' });
  ledger.issue(expired); now = 111;
  assert.throws(() => ledger.consume(evidence(expired), () => true), /CHALLENGE_EXPIRED/);
});
