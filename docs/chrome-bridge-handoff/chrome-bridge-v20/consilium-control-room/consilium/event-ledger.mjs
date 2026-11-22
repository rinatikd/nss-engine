import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{8,100}$/;
const ACTOR_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const TYPES = new Set([
  'session.started', 'session.paused', 'session.resumed', 'session.stop_requested', 'session.stopped',
  'comment.added', 'message.recorded', 'decision.proposed', 'decision.reviewed', 'decision.owner_approved',
  'decision.rejected', 'task.created', 'task.state_changed', 'artifact.linked', 'artifact.received', 'agent.availability'
]);
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const ZERO_HASH = '0'.repeat(64);
const ACTOR_ROLES = { owner: 'owner', chatgpt: 'operator', claude: 'operator', deepseek: 'participant', qwen: 'participant', kimi: 'participant', grok: 'participant', gemini: 'participant' };

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function eventBody(event) {
  return JSON.stringify({
    seq: event.seq, id: event.id, at: event.at, type: event.type,
    actor: event.actor, payload: event.payload, requestId: event.requestId,
    previousHash: event.previousHash
  });
}
function secretLike(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}/i.test(text);
}
function validateActor(actor) {
  if (!actor || typeof actor !== 'object' || !ACTOR_ID.test(actor.id || '') ||
      !ACTOR_ROLES[actor.id] || ACTOR_ROLES[actor.id] !== actor.role) {
    throw Error('INVALID_ACTOR');
  }
  return { id: actor.id, role: actor.role };
}
function clone(value) { return structuredClone(value); }

export class EventLedger {
  constructor(directory, { now = () => new Date().toISOString(), maxBytes = MAX_LEDGER_BYTES } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('LEDGER_DIRECTORY_MUST_BE_ABSOLUTE');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_LEDGER_BYTES) throw Error('INVALID_LEDGER_LIMIT');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('LEDGER_DIRECTORY_UNSAFE');
    this.directory = fs.realpathSync(directory);
    this.file = path.join(this.directory, 'events.jsonl');
    this.lockFile = path.join(this.directory, 'events.lock');
    this.now = now;
    this.maxBytes = maxBytes;
    this.lockToken = crypto.randomBytes(24).toString('hex');
    this.closed = false;
    this.events = [];
    this.byRequestId = new Map();
    this.state = null;
    this.lockFd = undefined;
    try {
      this.lockFd = fs.openSync(this.lockFile, 'wx', 0o600);
      fs.writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt: this.now() }));
      fs.fsyncSync(this.lockFd);
      this.#load();
      this.state = projectEvents(this.events);
    } catch (error) {
      try { if (this.lockFd !== undefined) fs.closeSync(this.lockFd); } catch {}
      this.lockFd = undefined;
      try {
        const lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
        if (lock.token === this.lockToken) fs.unlinkSync(this.lockFile);
      } catch {}
      throw error;
    }
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) throw Error('LEDGER_INVALID_OR_TOO_LARGE');
    const raw = fs.readFileSync(this.file, 'utf8');
    if (raw && !raw.endsWith('\n')) throw Error('LEDGER_TRUNCATED_FAIL_CLOSED');
    const lines = raw ? raw.trimEnd().split('\n') : [];
    let previousHash = ZERO_HASH;
    for (let index = 0; index < lines.length; index++) {
      let event;
      try { event = JSON.parse(lines[index]); } catch { throw Error('LEDGER_CORRUPT_FAIL_CLOSED'); }
      if (event.seq !== index + 1 || event.previousHash !== previousHash ||
          !TYPES.has(event.type) || typeof event.hash !== 'string' || event.hash !== sha256(eventBody(event))) {
        throw Error('LEDGER_CHAIN_INVALID_FAIL_CLOSED');
      }
      validateActor(event.actor);
      if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw Error('LEDGER_CORRUPT_FAIL_CLOSED');
      if (event.requestId) {
        if (!ID.test(event.requestId) || this.byRequestId.has(event.requestId)) throw Error('LEDGER_IDEMPOTENCY_INVALID');
        this.byRequestId.set(event.requestId, { event, fingerprint: sha256(JSON.stringify({ type: event.type, actor: event.actor, payload: event.payload })) });
      }
      previousHash = event.hash;
      this.events.push(event);
    }
    projectEvents(this.events);
  }

  append({ type, actor, payload = {}, requestId }) {
    if (this.closed) throw Error('LEDGER_CLOSED');
    if (!TYPES.has(type)) throw Error('UNKNOWN_EVENT_TYPE');
    const safeActor = validateActor(actor);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('INVALID_EVENT_PAYLOAD');
    if (requestId !== undefined && (typeof requestId !== 'string' || !ID.test(requestId))) throw Error('INVALID_REQUEST_ID');
    let safePayload;
    try { safePayload = clone(payload); } catch { throw Error('INVALID_EVENT_PAYLOAD'); }
    if (secretLike(safePayload)) throw Error('SECRET_LIKE_CONTENT_REJECTED');
    const fingerprint = sha256(JSON.stringify({ type, actor: safeActor, payload: safePayload }));
    if (requestId && this.byRequestId.has(requestId)) {
      const old = this.byRequestId.get(requestId);
      if (old.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
      return { ...clone(old.event), duplicate: true };
    }
    const previousHash = this.events.at(-1)?.hash || ZERO_HASH;
    const event = {
      seq: this.events.length + 1, id: crypto.randomUUID(), at: this.now(),
      type, actor: safeActor, payload: safePayload, requestId: requestId || null, previousHash
    };
    event.hash = sha256(eventBody(event));
    const line = JSON.stringify(event) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_EVENT_BYTES) throw Error('EVENT_TOO_LARGE');
    const nextState = projectEvents([...this.events, event]);
    const currentSize = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    if (currentSize + bytes > this.maxBytes) throw Error('LEDGER_FULL_FAIL_CLOSED');
    const fd = fs.openSync(this.file, 'a', 0o600);
    try {
      fs.writeFileSync(fd, line, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.events.push(event);
    this.state = nextState;
    if (requestId) this.byRequestId.set(requestId, { event, fingerprint });
    return { ...clone(event), duplicate: false };
  }

  list({ after = 0, limit = 1000 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw Error('INVALID_EVENT_WINDOW');
    return clone(this.events.filter(event => event.seq > after).slice(0, limit));
  }

  snapshot({ after = 0, limit = 1000 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw Error('INVALID_EVENT_WINDOW');
    return { state: clone(this.state), events: clone(this.events.filter(event => event.seq > after).slice(0, limit)) };
  }

  exportNdjson() {
    if (this.closed) throw Error('LEDGER_CLOSED');
    return this.events.map(event => JSON.stringify(event)).join('\\n') + (this.events.length ? '\\n' : '');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.lockFd !== undefined) fs.closeSync(this.lockFd); } catch {}
    this.lockFd = undefined;
    try {
      const lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (lock.token === this.lockToken) fs.unlinkSync(this.lockFile);
    } catch {}
  }
}

export function projectEvents(events) {
  const state = {
    session: { status: 'IDLE', id: null, title: null, epoch: 0 },
    decisions: [], tasks: [], messages: [], comments: [], artifacts: [], agents: [], lastSequence: 0
  };
  const decisionById = new Map();
  const taskById = new Map();
  const artifactById = new Map();
  for (const event of events) {
    state.lastSequence = event.seq;
    const p = event.payload;
    switch (event.type) {
      case 'session.started':
        if (!['IDLE', 'STOPPED'].includes(state.session.status)) throw Error('SESSION_ALREADY_ACTIVE');
        state.session = { status: 'RUNNING', id: p.sessionId, title: p.title, epoch: state.session.epoch + 1 };
        break;
      case 'session.paused':
        if (state.session.status !== 'RUNNING') throw Error('SESSION_NOT_RUNNING');
        state.session.status = 'PAUSED';
        break;
      case 'session.resumed':
        if (state.session.status !== 'PAUSED') throw Error('SESSION_NOT_PAUSED');
        state.session.status = 'RUNNING';
        break;
      case 'session.stop_requested':
        if (!['RUNNING', 'PAUSED'].includes(state.session.status)) throw Error('SESSION_NOT_ACTIVE');
        state.session.status = 'STOP_REQUESTED';
        state.session.epoch++;
        break;
      case 'session.stopped':
        if (state.session.status !== 'STOP_REQUESTED') throw Error('STOP_NOT_REQUESTED');
        state.session.status = 'STOPPED';
        break;
      case 'comment.added': state.comments.push(event); break;
      case 'message.recorded': state.messages.push(event); break;
      case 'decision.proposed': {
        if (decisionById.has(p.decisionId)) throw Error('DUPLICATE_DECISION_ID');
        if (!['routine', 'consequential'].includes(p.risk || 'consequential')) throw Error('INVALID_DECISION_RISK');
        const d = { id: p.decisionId, title: p.title, rationale: p.rationale, evidence: p.evidence || [], proposer: event.actor.id, risk: p.risk || 'consequential', status: 'PROPOSED', reviews: [], reviewHistory: [] };
        decisionById.set(d.id, d); state.decisions.push(d); break;
      }
      case 'decision.reviewed': {
        const d = decisionById.get(p.decisionId);
        if (!d || !['PROPOSED', 'UNDER_REVIEW', 'DISPUTED', 'NEEDS_EVIDENCE'].includes(d.status)) throw Error('DECISION_NOT_REVIEWABLE');
        if (event.actor.role !== 'operator' || !['chatgpt', 'claude'].includes(event.actor.id)) throw Error('CO_OPERATOR_REVIEW_REQUIRED');
        if (!['SUPPORT', 'OBJECT', 'NEEDS_EVIDENCE'].includes(p.verdict)) throw Error('INVALID_REVIEW_VERDICT');
        const prior = d.reviews.find(r => r.operator === event.actor.id);
        if (prior) {
          if (!['DISPUTED', 'NEEDS_EVIDENCE'].includes(d.status) || p.revisionOf !== prior.eventId) throw Error('REVIEW_REVISION_REQUIRES_PRIOR_EVENT');
          d.reviewHistory.push(prior);
          d.reviews = d.reviews.filter(r => r.operator !== event.actor.id);
        } else if (p.revisionOf) throw Error('REVIEW_REVISION_TARGET_NOT_FOUND');
        d.reviews.push({ eventId: event.id, operator: event.actor.id, verdict: p.verdict, rationale: p.rationale || '', evidence: p.evidence || [], at: event.at });
        if (d.reviews.some(r => r.verdict === 'OBJECT')) d.status = 'DISPUTED';
        else if (d.reviews.some(r => r.verdict === 'NEEDS_EVIDENCE')) d.status = 'NEEDS_EVIDENCE';
        else if (d.reviews.length === 2 && d.reviews.every(r => r.verdict === 'SUPPORT')) d.status = d.risk === 'routine' ? 'ACCEPTED' : 'READY_FOR_OWNER';
        else d.status = 'UNDER_REVIEW';
        break;
      }
      case 'decision.owner_approved': {
        const d = decisionById.get(p.decisionId);
        if (!d || d.status !== 'READY_FOR_OWNER') throw Error('DECISION_NOT_READY_FOR_OWNER');
        if (event.actor.role !== 'owner') throw Error('OWNER_APPROVAL_REQUIRED');
        d.status = 'ACCEPTED'; d.approvedBy = event.actor.id; d.approvedAt = event.at; break;
      }
      case 'decision.rejected': {
        const d = decisionById.get(p.decisionId);
        if (!d || !['PROPOSED', 'UNDER_REVIEW', 'DISPUTED', 'NEEDS_EVIDENCE', 'READY_FOR_OWNER'].includes(d.status)) throw Error('DECISION_NOT_REJECTABLE');
        if (event.actor.role !== 'owner') throw Error('OWNER_REJECTION_REQUIRED');
        d.status = 'REJECTED'; d.rejectionReason = p.reason; break;
      }
      case 'task.created': {
        const d = decisionById.get(p.decisionId);
        if (!d || d.status !== 'ACCEPTED') throw Error('TASK_REQUIRES_ACCEPTED_DECISION');
        if (taskById.has(p.taskId)) throw Error('DUPLICATE_TASK_ID');
        const t = { id: p.taskId, title: p.title, assignee: p.assignee, decisionId: p.decisionId, status: 'READY', evidence: [] };
        taskById.set(t.id, t); state.tasks.push(t); break;
      }
      case 'task.state_changed': {
        const t = taskById.get(p.taskId);
        if (!t) throw Error('TASK_NOT_FOUND');
        const allowed = { READY: ['IN_PROGRESS', 'BLOCKED'], IN_PROGRESS: ['IN_REVIEW', 'BLOCKED', 'FAILED'], IN_REVIEW: ['VERIFIED', 'IN_PROGRESS', 'BLOCKED'], BLOCKED: ['IN_PROGRESS'], FAILED: ['IN_PROGRESS'] };
        if (!(allowed[t.status] || []).includes(p.status)) throw Error('INVALID_TASK_TRANSITION');
        if (p.status === 'VERIFIED' && (!p.commitSha || !Array.isArray(p.evidence) || !p.evidence.length)) throw Error('VERIFICATION_EVIDENCE_REQUIRED');
        t.status = p.status; t.updatedBy = event.actor.id; t.updatedAt = event.at;
        if (p.commitSha) t.commitSha = p.commitSha;
        if (p.evidence) t.evidence = p.evidence;
        break;
      }
      case 'artifact.linked': {
        if (artifactById.has(p.artifactId) || !/^[a-f0-9]{64}$/.test(p.sha256 || '') || !Array.isArray(p.recipients) || !p.recipients.length) throw Error('INVALID_ARTIFACT_MANIFEST');
        const artifact = { id: p.artifactId, name: p.name, sha256: p.sha256, sourceCommit: p.sourceCommit, uri: p.uri, recipients: p.recipients, receipts: [] };
        artifactById.set(artifact.id, artifact); state.artifacts.push(artifact); break;
      }
      case 'artifact.received': {
        const artifact = artifactById.get(p.artifactId);
        if (!artifact || !artifact.recipients.includes(event.actor.id) || p.sha256 !== artifact.sha256) throw Error('ARTIFACT_RECEIPT_MISMATCH');
        if (artifact.receipts.some(r => r.actor === event.actor.id)) throw Error('ARTIFACT_ALREADY_RECEIVED');
        artifact.receipts.push({ actor: event.actor.id, at: event.at, receiptId: p.receiptId || null }); break;
      }
      case 'agent.availability': state.agents = state.agents.filter(a => a.agent !== p.agent); state.agents.push({ agent: p.agent, status: p.status, observedAt: event.at, details: p.details || null }); break;
    }
  }
  return state;
}
