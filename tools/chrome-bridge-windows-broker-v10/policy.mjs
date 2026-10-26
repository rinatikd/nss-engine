import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const THUMBPRINT = /^[a-f0-9]{40,64}$/i;
const ID = /^[a-z0-9_-]{1,32}$/;
const ownKeys = (value, allowed, required = allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('POLICY_OBJECT_REQUIRED');
  const keys = Object.keys(value);
  if (keys.some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) throw new Error('POLICY_KEYS_INVALID');
};

export function canonicalLocalPath(input, { directory, stat = fs.statSync, lstat = fs.lstatSync, realpath = fs.realpathSync.native } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.startsWith('\\\\') || /[\0-\x1f]/.test(input) || input.slice(2).includes(':')) throw new Error('POLICY_PATH_INVALID');
  const resolved = path.resolve(input);
  let parent = path.parse(resolved).root;
  for (const segment of resolved.slice(parent.length).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, segment);
    const part = lstat(parent);
    if (part.isSymbolicLink()) throw new Error('POLICY_REPARSE_POINT_DENIED');
    if (!part.isDirectory() && Number(part.nlink) > 1) throw new Error('POLICY_HARDLINK_DENIED');
  }
  const info = stat(resolved);
  if (info.isDirectory() !== directory) throw new Error('POLICY_PATH_TYPE_INVALID');
  const canonical = realpath(resolved);
  const equal = process.platform === 'win32' ? canonical.toLowerCase() === resolved.toLowerCase() : canonical === resolved;
  if (!equal) throw new Error('POLICY_PATH_ALIAS_DENIED');
  return canonical;
}

function imagePin(value, label) {
  ownKeys(value, ['path', 'sha256', 'signerThumbprint', 'version']);
  if (!SHA256.test(value.sha256) || !THUMBPRINT.test(value.signerThumbprint) || typeof value.version !== 'string' || !value.version.trim()) throw new Error(`${label}_PIN_INVALID`);
  if (typeof value.path !== 'string' || !path.isAbsolute(value.path)) throw new Error(`${label}_PATH_INVALID`);
}

/** Parse strict JSON data only. Never import/evaluate policy code. v0.9 cannot activate execution. */
export function parseBrokerPolicy(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('POLICY_SIZE_INVALID');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('POLICY_JSON_INVALID'); }
  ownKeys(data, ['schemaVersion', 'enabled', 'broker', 'codex', 'workspaces', 'approval', 'limits']);
  if (data.schemaVersion !== 1) throw new Error('POLICY_VERSION_UNSUPPORTED');
  if (data.enabled !== false) throw new Error('ACTIVATION_NOT_ATTESTED');
  imagePin(data.broker, 'BROKER');
  imagePin(data.codex, 'CODEX');
  if (!data.broker.path.toLowerCase().endsWith('.exe') || !data.codex.path.toLowerCase().endsWith('.exe')) throw new Error('NATIVE_EXECUTABLE_REQUIRED');
  if (!data.workspaces || typeof data.workspaces !== 'object' || Array.isArray(data.workspaces)) throw new Error('WORKSPACE_MAP_INVALID');
  const ids = Object.keys(data.workspaces);
  if (!ids.length || ids.length > 32 || ids.some(id => !ID.test(id))) throw new Error('WORKSPACE_MAP_INVALID');
  for (const item of Object.values(data.workspaces)) {
    ownKeys(item, ['path', 'access']);
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path) || item.access !== 'read-only') throw new Error('WORKSPACE_POLICY_INVALID');
  }
  ownKeys(data.approval, ['perJobLocalConfirmation', 'dangerousActions']);
  if (data.approval.perJobLocalConfirmation !== true || data.approval.dangerousActions !== 'deny') throw new Error('APPROVAL_POLICY_INVALID');
  ownKeys(data.limits, ['timeoutSeconds', 'maxOutputBytes', 'maxProcesses', 'maxMemoryBytes']);
  if (!Number.isInteger(data.limits.timeoutSeconds) || data.limits.timeoutSeconds < 1 || data.limits.timeoutSeconds > 300 ||
      !Number.isInteger(data.limits.maxOutputBytes) || data.limits.maxOutputBytes < 1024 || data.limits.maxOutputBytes > 2_097_152 ||
      data.limits.maxProcesses !== 1 || !Number.isInteger(data.limits.maxMemoryBytes) || data.limits.maxMemoryBytes < 64 * 1024 * 1024 || data.limits.maxMemoryBytes > 512 * 1024 * 1024) throw new Error('POLICY_LIMITS_INVALID');
  return Object.freeze(structuredClone(data));
}

/** Compare executable bytes and externally verified Authenticode facts; never execute the image. */
export function verifyPinnedImage({ filePath, expected, bytes, signature }) {
  if (!expected || !SHA256.test(expected.sha256 || '') || !THUMBPRINT.test(expected.signerThumbprint || '')) throw new Error('IMAGE_PIN_INVALID');
  const expectedPath = path.resolve(expected.path || '');
  const actualPath = path.resolve(filePath || '');
  const samePath = process.platform === 'win32' ? expectedPath.toLowerCase() === actualPath.toLowerCase() : expectedPath === actualPath;
  if (!samePath) throw new Error('IMAGE_PATH_MISMATCH');
  bytes ??= fs.readFileSync(actualPath);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected.sha256) throw new Error('IMAGE_HASH_MISMATCH');
  if (!signature || signature.status !== 'Valid' || signature.signerThumbprint?.toLowerCase() !== expected.signerThumbprint.toLowerCase()) throw new Error('IMAGE_SIGNATURE_UNVERIFIED');
  return { hashMatches: true, signatureMatches: true, executableStarted: false };
}

/** Validate a separately collected ACL snapshot; caller must obtain it from trusted Win32 APIs. */
export function validateProtectedAcl(snapshot, { ownerSid, serviceSid }) {
  ownKeys(snapshot, ['ownerSid', 'daclProtected', 'aces']);
  if (snapshot.ownerSid !== ownerSid || snapshot.daclProtected !== true || !Array.isArray(snapshot.aces) || !snapshot.aces.length) throw new Error('POLICY_ACL_UNPROTECTED');
  for (const ace of snapshot.aces) {
    ownKeys(ace, ['sid', 'access', 'type', 'inherited']);
    if (ace.inherited !== false || ace.type !== 'allow' || !['read', 'read-execute', 'full-control'].includes(ace.access)) throw new Error('POLICY_ACL_ACE_INVALID');
    if (![ownerSid, 'S-1-5-18', serviceSid].includes(ace.sid)) throw new Error('POLICY_ACL_PRINCIPAL_DENIED');
    if (ace.sid === serviceSid && !['read', 'read-execute'].includes(ace.access)) throw new Error('POLICY_ACL_SERVICE_WRITE_DENIED');
  }
  if (!snapshot.aces.some(x => x.sid === ownerSid && x.access === 'full-control') ||
      !snapshot.aces.some(x => x.sid === 'S-1-5-18' && x.access === 'full-control') ||
      !snapshot.aces.some(x => x.sid === serviceSid && ['read', 'read-execute'].includes(x.access))) throw new Error('POLICY_ACL_REQUIRED_ACE_MISSING');
  return { aclShapeValid: true, osAclProven: false };
}

/** Resolve all configured paths without trusting config-provided executable policy code. */
export function resolvePolicyPaths(policy, options = {}) {
  if (!policy || policy.enabled !== false) throw new Error('ACTIVATION_NOT_ATTESTED');
  const broker = canonicalLocalPath(policy.broker.path, { ...options, directory: false });
  const codex = canonicalLocalPath(policy.codex.path, { ...options, directory: false });
  const workspaces = Object.fromEntries(Object.entries(policy.workspaces).map(([id, item]) => [id, canonicalLocalPath(item.path, { ...options, directory: true })]));
  return Object.freeze({ broker, codex, workspaces });
}

export const brokerRequiredEvidence = Object.freeze([
  'appContainer', 'network', 'credentials', 'workspace', 'handles', 'environment', 'job', 'cleanup',
]);

/** Attestation validator: schema-complete evidence is necessary, never proof of the OS claim. */
export function validateAttestation(evidence, expected, verifyBrokerImage) {
  ownKeys(evidence, ['protocol', 'nonce', 'policySha256', 'brokerSha256', 'codexSha256', 'workspaceId', 'evidence']);
  ownKeys(expected, ['nonce', 'policySha256', 'brokerSha256', 'codexSha256', 'workspaceId']);
  if (evidence.protocol !== 1 || evidence.nonce !== expected.nonce ||
      evidence.policySha256 !== expected.policySha256 || evidence.brokerSha256 !== expected.brokerSha256 ||
      evidence.codexSha256 !== expected.codexSha256 || evidence.workspaceId !== expected.workspaceId) throw new Error('ATTESTATION_BINDING_MISMATCH');
  if (typeof verifyBrokerImage !== 'function' || verifyBrokerImage() !== true) throw new Error('BROKER_TRUST_UNVERIFIED');
  ownKeys(evidence.evidence, brokerRequiredEvidence);
  const e = evidence.evidence;
  ownKeys(e.appContainer, ['enabled', 'sid', 'lowPrivilege', 'lpac', 'capabilitySids']);
  if (e.appContainer.enabled !== true || e.appContainer.lowPrivilege !== true || e.appContainer.lpac !== true ||
      typeof e.appContainer.sid !== 'string' || !/^S-1-15-2-(?:[0-9]+-){1,16}[0-9]+$/.test(e.appContainer.sid) ||
      !Array.isArray(e.appContainer.capabilitySids) || e.appContainer.capabilitySids.length !== 0) throw new Error('ATTESTATION_APPCONTAINER_INCOMPLETE');
  ownKeys(e.network, ['outboundAllowed', 'denialProbePassed']);
  if (e.network.outboundAllowed !== false || e.network.denialProbePassed !== true) throw new Error('ATTESTATION_NETWORK_INCOMPLETE');
  ownKeys(e.credentials, ['profileReadDenied', 'codexHomeReadDenied', 'syntheticCredentialReadDenied']);
  if (Object.values(e.credentials).some(x => x !== true)) throw new Error('ATTESTATION_CREDENTIAL_ISOLATION_INCOMPLETE');
  ownKeys(e.workspace, ['pathSha256', 'readOnly', 'writeProbeDenied']);
  if (!SHA256.test(e.workspace.pathSha256 || '') || e.workspace.readOnly !== true || e.workspace.writeProbeDenied !== true) throw new Error('ATTESTATION_WORKSPACE_INCOMPLETE');
  if (!Array.isArray(e.handles) || JSON.stringify([...e.handles].sort()) !== JSON.stringify(['stderr', 'stdin', 'stdout'])) throw new Error('ATTESTATION_HANDLE_ALLOWLIST_INVALID');
  if (!Array.isArray(e.environment) || JSON.stringify([...e.environment].sort()) !== JSON.stringify(['SystemRoot', 'TEMP', 'TMP'])) throw new Error('ATTESTATION_ENV_ALLOWLIST_INVALID');
  ownKeys(e.job, ['killOnClose', 'activeProcessLimit', 'childProcessRestricted', 'memoryLimitBytes', 'cpuTimeLimit100ns', 'descendantsEmptyAfterCrash']);
  if (e.job.killOnClose !== true || e.job.activeProcessLimit !== 1 || e.job.childProcessRestricted !== true ||
      !Number.isInteger(e.job.memoryLimitBytes) || e.job.memoryLimitBytes < 64 * 1024 * 1024 || e.job.memoryLimitBytes > 512 * 1024 * 1024 ||
      !Number.isInteger(e.job.cpuTimeLimit100ns) || e.job.cpuTimeLimit100ns < 100_000 || e.job.descendantsEmptyAfterCrash !== true) throw new Error('ATTESTATION_JOB_INCOMPLETE');
  ownKeys(e.cleanup, ['fixtureRemoved', 'handlesClosed']);
  if (e.cleanup.fixtureRemoved !== true || e.cleanup.handlesClosed !== true) throw new Error('ATTESTATION_CLEANUP_INCOMPLETE');
  // Deliberately do not return an authorization token or an executable capability.
  return { contractShapeValid: true, osIsolationProven: false, executionAuthorized: false };
}

export function createChallenge({ nonce = crypto.randomBytes(32).toString('hex'), policySha256, brokerSha256, codexSha256, workspaceId }) {
  if (!/^[a-f0-9]{64}$/.test(nonce) || ![policySha256, brokerSha256, codexSha256].every(x => SHA256.test(x || '')) || !ID.test(workspaceId || '')) throw new Error('CHALLENGE_INVALID');
  return Object.freeze({ nonce, policySha256, brokerSha256, codexSha256, workspaceId });
}

export class ChallengeLedger {
  #issued = new Map();
  constructor({ ttlMs = 30_000, now = Date.now } = {}) { this.ttlMs = ttlMs; this.now = now; }
  issue(challenge) {
    if (!challenge || !/^[a-f0-9]{64}$/.test(challenge.nonce) || this.#issued.has(challenge.nonce)) throw new Error('CHALLENGE_REPLAY');
    this.#issued.set(challenge.nonce, { expected: challenge, expiresAt: this.now() + this.ttlMs });
    return challenge;
  }
  consume(evidence, verifyBrokerImage) {
    const item = this.#issued.get(evidence?.nonce);
    if (!item) throw new Error('CHALLENGE_UNKNOWN_OR_REPLAYED');
    this.#issued.delete(evidence.nonce); // consume before validation, including failure cases
    if (this.now() > item.expiresAt) throw new Error('CHALLENGE_EXPIRED');
    return validateAttestation(evidence, item.expected, verifyBrokerImage);
  }
}
