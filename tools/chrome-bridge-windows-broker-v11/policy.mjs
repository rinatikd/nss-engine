import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9_-]{1,32}$/;
const CONTROL = /[\0-\x1f\x7f]/;
const authoredChallenges = new WeakSet();
const ownKeys = (value, allowed, required = allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('POLICY_OBJECT_REQUIRED');
  const keys = Object.keys(value);
  if (keys.some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) throw new Error('POLICY_KEYS_INVALID');
};
const freezeTree = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
};
const pinHash = value => typeof value === 'string' && SHA256.test(value) && !/^0+$/.test(value);

/** Syntax validation only. It does not resolve a filesystem path or confer file identity. */
export function validateWindowsPathSyntax(value, { executable = false } = {}) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 240 || CONTROL.test(value) ||
      !/^[A-Za-z]:\\/.test(value) || value.startsWith('\\\\') || value.includes('/') ||
      value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\') || value.slice(2).includes(':')) throw new Error('POLICY_PATH_SYNTAX_INVALID');
  const components = value.slice(3).split('\\');
  if (components.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part))) throw new Error('POLICY_PATH_COMPONENT_INVALID');
  const reserved = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
  if (components.some(part => reserved.test(part))) throw new Error('POLICY_PATH_RESERVED_NAME');
  if (executable && !value.toLowerCase().endsWith('.exe')) throw new Error('NATIVE_EXECUTABLE_REQUIRED');
  return value;
}

function imagePin(value, label) {
  ownKeys(value, ['path', 'sha256', 'signerCertificateSha256', 'version']);
  validateWindowsPathSyntax(value.path, { executable: true });
  if (!pinHash(value.sha256) || !pinHash(value.signerCertificateSha256)) throw new Error(`${label}_PIN_INVALID`);
  if (typeof value.version !== 'string' || value.version.length < 1 || value.version.length > 128 || CONTROL.test(value.version) || /placeholder|unpin|example/i.test(value.version)) throw new Error(`${label}_VERSION_INVALID`);
}

/** Strict JSON data only. Runtime activation remains denied in v0.11. */
export function parseBrokerPolicy(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('POLICY_SIZE_INVALID');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('POLICY_JSON_INVALID'); }
  ownKeys(data, ['schemaVersion', 'enabled', 'broker', 'codex', 'workspaces', 'approval', 'limits']);
  if (data.schemaVersion !== 1) throw new Error('POLICY_VERSION_UNSUPPORTED');
  if (data.enabled !== false) throw new Error('ACTIVATION_NOT_ATTESTED');
  imagePin(data.broker, 'BROKER'); imagePin(data.codex, 'CODEX');
  if (!data.workspaces || typeof data.workspaces !== 'object' || Array.isArray(data.workspaces)) throw new Error('WORKSPACE_MAP_INVALID');
  const ids = Object.keys(data.workspaces);
  if (!ids.length || ids.length > 32 || ids.some(id => !ID.test(id))) throw new Error('WORKSPACE_MAP_INVALID');
  for (const item of Object.values(data.workspaces)) {
    ownKeys(item, ['path', 'access']);
    validateWindowsPathSyntax(item.path);
    if (item.access !== 'read-only') throw new Error('WORKSPACE_POLICY_INVALID');
  }
  ownKeys(data.approval, ['perJobLocalConfirmation', 'dangerousActions']);
  if (data.approval.perJobLocalConfirmation !== true || data.approval.dangerousActions !== 'deny') throw new Error('APPROVAL_POLICY_INVALID');
  ownKeys(data.limits, ['timeoutSeconds', 'maxOutputBytes', 'maxProcesses', 'maxMemoryBytes']);
  if (!Number.isInteger(data.limits.timeoutSeconds) || data.limits.timeoutSeconds < 1 || data.limits.timeoutSeconds > 300 ||
      !Number.isInteger(data.limits.maxOutputBytes) || data.limits.maxOutputBytes < 1024 || data.limits.maxOutputBytes > 2_097_152 ||
      data.limits.maxProcesses !== 1 || !Number.isInteger(data.limits.maxMemoryBytes) || data.limits.maxMemoryBytes < 64 * 1024 * 1024 || data.limits.maxMemoryBytes > 512 * 1024 * 1024) throw new Error('POLICY_LIMITS_INVALID');
  return freezeTree(structuredClone(data));
}

/**
 * Caller JSON/bytes/signature objects are never Windows trust evidence.
 * A native handle-bound provider is not linked in this source-only package.
 */
export function verifyPinnedImage() {
  throw new Error('NATIVE_HANDLE_VERIFIER_NOT_LINKED');
}

/** A caller-supplied ACL snapshot is never accepted as Windows ACL evidence. */
export function validateProtectedAcl() {
  throw new Error('NATIVE_HANDLE_ACL_PROVIDER_REQUIRED');
}

export const brokerRequiredEvidence = Object.freeze([
  'appContainer', 'network', 'credentials', 'workspace', 'handles', 'environment', 'job', 'cleanup',
]);

/** Validate claim shape for reports only. This function never proves host origin or isolation. */
export function validateAttestationShape(evidence, expected) {
  ownKeys(evidence, ['protocol', 'nonce', 'policySha256', 'brokerSha256', 'codexSha256', 'workspaceId', 'evidence']);
  ownKeys(expected, ['nonce', 'policySha256', 'brokerSha256', 'codexSha256', 'workspaceId']);
  if (evidence.protocol !== 2 || evidence.nonce !== expected.nonce || evidence.policySha256 !== expected.policySha256 ||
      evidence.brokerSha256 !== expected.brokerSha256 || evidence.codexSha256 !== expected.codexSha256 ||
      evidence.workspaceId !== expected.workspaceId) throw new Error('ATTESTATION_BINDING_MISMATCH');
  ownKeys(evidence.evidence, brokerRequiredEvidence);
  const e = evidence.evidence;
  ownKeys(e.appContainer, ['enabled', 'sid', 'lowPrivilege', 'lpac', 'capabilitySids']);
  if (e.appContainer.enabled !== true || e.appContainer.lowPrivilege !== true || e.appContainer.lpac !== true ||
      typeof e.appContainer.sid !== 'string' || !/^S-1-15-2-(?:[0-9]+-){1,16}[0-9]+$/.test(e.appContainer.sid) ||
      !Array.isArray(e.appContainer.capabilitySids) || e.appContainer.capabilitySids.length !== 0) throw new Error('ATTESTATION_APPCONTAINER_SHAPE_INVALID');
  ownKeys(e.network, ['outboundAllowed', 'denialProbePassed']);
  if (e.network.outboundAllowed !== false || e.network.denialProbePassed !== true) throw new Error('ATTESTATION_NETWORK_SHAPE_INVALID');
  ownKeys(e.credentials, ['profileReadDenied', 'codexHomeReadDenied', 'syntheticCredentialReadDenied']);
  if (Object.values(e.credentials).some(x => x !== true)) throw new Error('ATTESTATION_CREDENTIAL_SHAPE_INVALID');
  ownKeys(e.workspace, ['pathSha256', 'readOnly', 'writeProbeDenied']);
  if (!pinHash(e.workspace.pathSha256) || e.workspace.readOnly !== true || e.workspace.writeProbeDenied !== true) throw new Error('ATTESTATION_WORKSPACE_SHAPE_INVALID');
  if (!Array.isArray(e.handles) || JSON.stringify([...e.handles].sort()) !== JSON.stringify(['stderr', 'stdin', 'stdout'])) throw new Error('ATTESTATION_HANDLE_SHAPE_INVALID');
  if (!Array.isArray(e.environment) || JSON.stringify([...e.environment].sort()) !== JSON.stringify(['SystemRoot', 'TEMP', 'TMP'])) throw new Error('ATTESTATION_ENV_SHAPE_INVALID');
  ownKeys(e.job, ['killOnClose', 'activeProcessLimit', 'breakawayDisabled', 'childProcessRestricted', 'memoryLimitBytes', 'cpuTimeLimit100ns', 'descendantsEmptyAfterCrash']);
  if (e.job.killOnClose !== true || e.job.activeProcessLimit !== 1 || e.job.breakawayDisabled !== true || e.job.childProcessRestricted !== true ||
      !Number.isInteger(e.job.memoryLimitBytes) || e.job.memoryLimitBytes < 64 * 1024 * 1024 || e.job.memoryLimitBytes > 512 * 1024 * 1024 ||
      !Number.isInteger(e.job.cpuTimeLimit100ns) || e.job.cpuTimeLimit100ns < 100_000 || e.job.descendantsEmptyAfterCrash !== true) throw new Error('ATTESTATION_JOB_SHAPE_INVALID');
  ownKeys(e.cleanup, ['fixtureRemoved', 'handlesClosed', 'childTerminated']);
  if (e.cleanup.fixtureRemoved !== true || e.cleanup.handlesClosed !== true || e.cleanup.childTerminated !== true) throw new Error('ATTESTATION_CLEANUP_SHAPE_INVALID');
  return Object.freeze({ contractShapeValid: true, hostOriginVerified: false, osIsolationProven: false, executionAuthorized: false });
}

export function createChallenge({ policySha256, brokerSha256, codexSha256, workspaceId }) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const challenge = { nonce, policySha256, brokerSha256, codexSha256, workspaceId };
  validateChallenge(challenge);
  freezeTree(challenge);
  authoredChallenges.add(challenge);
  return challenge;
}

function validateChallenge(value) {
  ownKeys(value, ['nonce', 'policySha256', 'brokerSha256', 'codexSha256', 'workspaceId']);
  if (!SHA256.test(value.nonce) || ![value.policySha256, value.brokerSha256, value.codexSha256].every(pinHash) || !ID.test(value.workspaceId)) throw new Error('CHALLENGE_INVALID');
}

export class ChallengeLedger {
  #issued = new Map();
  #now = () => performance.now();
  #ttlMs;
  #maxOutstanding;
  constructor(options = {}) {
    ownKeys(options, ['ttlMs', 'maxOutstanding'], []);
    const { ttlMs = 30_000, maxOutstanding = 512 } = options;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000 || !Number.isInteger(maxOutstanding) || maxOutstanding < 1 || maxOutstanding > 4_096) throw new Error('CHALLENGE_LEDGER_CONFIG_INVALID');
    this.#ttlMs = ttlMs; this.#maxOutstanding = maxOutstanding;
  }
  #purgeExpired(now) {
    for (const [nonce, entry] of this.#issued) if (entry.expiresAt <= now) this.#issued.delete(nonce);
  }
  issue(challenge) {
    if (!authoredChallenges.has(challenge)) throw new Error('CHALLENGE_NOT_AUTHORED');
    validateChallenge(challenge);
    const now = this.#now(); this.#purgeExpired(now);
    if (this.#issued.has(challenge.nonce)) throw new Error('CHALLENGE_REPLAY');
    if (this.#issued.size >= this.#maxOutstanding) throw new Error('CHALLENGE_LEDGER_FULL');
    const snapshot = freezeTree(structuredClone(challenge));
    this.#issued.set(snapshot.nonce, { expected: snapshot, expiresAt: now + this.#ttlMs });
    return snapshot;
  }
  consume(evidence) {
    const nonce = evidence && typeof evidence === 'object' && typeof evidence.nonce === 'string' ? evidence.nonce : undefined;
    const entry = this.#issued.get(nonce);
    if (!entry) throw new Error('CHALLENGE_UNKNOWN_OR_REPLAYED');
    this.#issued.delete(nonce); // terminally consume before any validation to prevent replay on failure
    if (this.#now() >= entry.expiresAt) throw new Error('CHALLENGE_EXPIRED');
    return validateAttestationShape(evidence, entry.expected);
  }
  clear() { this.#issued.clear(); } // Call on process restart/worker-generation change.
  get size() { return this.#issued.size; }
}
