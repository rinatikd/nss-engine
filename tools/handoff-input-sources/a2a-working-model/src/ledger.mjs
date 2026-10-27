import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Task ledger: the single source of truth for delivery state. A2A-shaped task (id, contextId, state, artifacts)
// plus what A2A does not give: an explicit UNKNOWN delivery state, write-ahead dispatch marker, leases with
// fencing, idempotency conflict detection and an operator-only way out of UNKNOWN.
//
// Durability: SQLite WAL + synchronous=FULL (commit is synced). Process death (SIGKILL) is tested here;
// power-loss behaviour follows SQLite's documented guarantees and is NOT tested by this repository.

export const STATE = Object.freeze({
  SUBMITTED: 'submitted', WORKING: 'working', INPUT_REQUIRED: 'input_required',
  COMPLETED: 'completed', FAILED: 'failed', CANCELED: 'canceled',
  UNKNOWN: 'unknown', // dispatched, outcome not provable. NEVER retried automatically.
});
export const TERMINAL = new Set([STATE.COMPLETED, STATE.FAILED, STATE.CANCELED]);
export class LedgerError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const PARTY = /^[a-z0-9_-]{1,32}$/;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, context_id TEXT NOT NULL, parent_id TEXT, depth INTEGER NOT NULL DEFAULT 0,
  sender TEXT NOT NULL, recipient TEXT NOT NULL, fingerprint TEXT NOT NULL, text TEXT NOT NULL,
  state TEXT NOT NULL, owner TEXT, lease_until INTEGER, fence INTEGER NOT NULL DEFAULT 0,
  dispatch_started INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(recipient, state, created_at);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
`;

export function loadOrCreateKey(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) { try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new LedgerError('KEY_CORRUPT_FAIL_CLOSED');
  return key;
}

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(SCHEMA);
  return db;
}
// BEGIN IMMEDIATE takes the write lock up front: concurrent claimers serialise instead of deadlocking.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
const view = (r) => r ? { id: r.id, contextId: r.context_id, parentId: r.parent_id, depth: r.depth, sender: r.sender, recipient: r.recipient,
  state: r.state, owner: r.owner, leaseUntil: r.lease_until, fence: r.fence, dispatchStarted: !!r.dispatch_started, attempts: r.attempts,
  text: r.text, createdAt: r.created_at, updatedAt: r.updated_at } : null;

class Base {
  constructor(file, { now = Date.now, keyFile = file + '.key' } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new LedgerError('ABSOLUTE_PATH_REQUIRED');
    this.file = file; this.now = now; this.key = loadOrCreateKey(keyFile); this.db = open(file);
  }
  close() { this.db.close(); }
  get(id) { return view(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)); }
  events(id) { return this.db.prepare('SELECT seq,kind,body,at FROM events WHERE task_id=? ORDER BY seq').all(id).map((e) => ({ seq: e.seq, kind: e.kind, body: JSON.parse(e.body), at: e.at })); }
  _event(id, kind, body = {}) { this.db.prepare('INSERT INTO events(task_id,kind,body,at) VALUES(?,?,?,?)').run(id, kind, JSON.stringify(body), this.now()); }
}

/** Handle given to submitters and dispatchers. It has NO way to leave UNKNOWN. */
export class Ledger extends Base {
  constructor(file, opts = {}) { super(file, opts); this.maxDepth = opts.maxDepth ?? 2; this.maxTasksPerContext = opts.maxTasksPerContext ?? 20; this.maxAttempts = opts.maxAttempts ?? 3; }
  fingerprint(contextId, recipient, text) { return crypto.createHmac('sha256', this.key).update(JSON.stringify([contextId, recipient, text])).digest('hex'); }

  /** Idempotent by id. Same id + same content => duplicate; same id + different content => conflict (never silently reused). */
  submit({ id, contextId, sender, recipient, text, parentId = null }) {
    if (!ID.test(id ?? '') || !ID.test(contextId ?? '') || !PARTY.test(sender ?? '') || !PARTY.test(recipient ?? '') || typeof text !== 'string' || !text || Buffer.byteLength(text) > 65536) throw new LedgerError('INVALID_TASK');
    const fp = this.fingerprint(contextId, recipient, text);
    return tx(this.db, () => {
      const prior = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (prior) return { result: prior.fingerprint === fp ? 'duplicate' : 'conflict', task: view(prior) };
      let depth = 0;
      if (parentId !== null) {
        const p = this.db.prepare('SELECT depth,context_id FROM tasks WHERE id=?').get(parentId);
        if (!p || p.context_id !== contextId) throw new LedgerError('PARENT_INVALID');
        depth = p.depth + 1;
        if (depth > this.maxDepth) throw new LedgerError('DEPTH_LIMIT');
      }
      const used = this.db.prepare('SELECT COUNT(*) n FROM tasks WHERE context_id=?').get(contextId).n;
      if (used >= this.maxTasksPerContext) throw new LedgerError('BUDGET_EXCEEDED');
      const t = this.now();
      this.db.prepare('INSERT INTO tasks(id,context_id,parent_id,depth,sender,recipient,fingerprint,text,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, contextId, parentId, depth, sender, recipient, fp, text, STATE.SUBMITTED, t, t);
      this._event(id, 'submitted', { sender, recipient, parentId });
      return { result: 'created', task: this.get(id) };
    });
  }
  next(recipient) { return this.db.prepare("SELECT id FROM tasks WHERE recipient=? AND state='submitted' ORDER BY created_at, id LIMIT 1").get(recipient)?.id ?? null; }

  /** Atomic claim: exactly one caller can move submitted -> working. Returns the fencing token. */
  claim(id, owner, ttlMs) {
    if (!PARTY.test(owner) || !Number.isInteger(ttlMs) || ttlMs < 1) throw new LedgerError('INVALID_CLAIM');
    return tx(this.db, () => {
      const t = this.now();
      const r = this.db.prepare("UPDATE tasks SET state='working', owner=?, lease_until=?, fence=fence+1, attempts=attempts+1, dispatch_started=0, updated_at=? WHERE id=? AND state='submitted'").run(owner, t + ttlMs, t, id);
      if (r.changes !== 1) return { ok: false };
      const fence = this.db.prepare('SELECT fence FROM tasks WHERE id=?').get(id).fence;
      this._event(id, 'claimed', { owner, fence });
      return { ok: true, fence };
    });
  }
  _guard(id, owner, fence, sql, params, kind, body) {
    return tx(this.db, () => {
      const t = this.now();
      const r = this.db.prepare(sql).run(...params(t));
      if (r.changes !== 1) throw new LedgerError('STALE_OR_ILLEGAL', { id, kind, state: this.get(id)?.state });
      this._event(id, kind, { owner, fence, ...body });
      return this.get(id);
    });
  }
  /** Write-ahead marker, committed BEFORE anything leaves the process. After this a crash can only mean UNKNOWN. */
  beginDispatch(id, owner, fence) {
    return this._guard(id, owner, fence, "UPDATE tasks SET dispatch_started=1, updated_at=? WHERE id=? AND state='working' AND owner=? AND fence=? AND lease_until>? AND dispatch_started=0",
      (t) => [t, id, owner, fence, t], 'dispatch_started');
  }
  renew(id, owner, fence, ttlMs) {
    return this._guard(id, owner, fence, "UPDATE tasks SET lease_until=?, updated_at=? WHERE id=? AND state='working' AND owner=? AND fence=? AND lease_until>?",
      (t) => [t + ttlMs, t, id, owner, fence, t], 'lease_renewed');
  }
  /** Result arrives. Accepted only from the current fence while still WORKING; a late result after the reaper moved the task is recorded for the operator, never applied. */
  complete(id, owner, fence, artifact) {
    const body = JSON.stringify({ text: String(artifact?.text ?? ''), meta: artifact?.meta ?? {} });
    try {
      return this._guard(id, owner, fence, "UPDATE tasks SET state='completed', updated_at=? WHERE id=? AND state='working' AND owner=? AND fence=? AND dispatch_started=1",
        (t) => [t, id, owner, fence], 'completed', { artifact: JSON.parse(body) });
    } catch (e) {
      if (e.code === 'STALE_OR_ILLEGAL') { this._event(id, 'late_result_rejected', { owner, fence, artifact: JSON.parse(body) }); }
      throw e;
    }
  }
  fail(id, owner, fence, code) {
    return this._guard(id, owner, fence, "UPDATE tasks SET state='failed', updated_at=? WHERE id=? AND state='working' AND owner=? AND fence=?", (t) => [t, id, owner, fence], 'failed', { code: String(code).slice(0, 64) });
  }
  requireInput(id, owner, fence, question) {
    return this._guard(id, owner, fence, "UPDATE tasks SET state='input_required', updated_at=? WHERE id=? AND state='working' AND owner=? AND fence=?", (t) => [t, id, owner, fence], 'input_required', { question: String(question).slice(0, 500) });
  }
  /** Outcome not provable (timeout, disconnect, crash after dispatch). Never goes back to submitted by itself. */
  markUnknown(id, owner, fence, reason) {
    return this._guard(id, owner, fence, "UPDATE tasks SET state='unknown', updated_at=? WHERE id=? AND state='working' AND owner=? AND fence=? AND dispatch_started=1", (t) => [t, id, owner, fence], 'unknown', { reason: String(reason).slice(0, 64) });
  }
  /**
   * Back to the queue. Allowed ONLY when nothing was dispatched, or when the adapter PROVED non-delivery
   * (proven:true, e.g. refused before the send). Gives up (failed) after maxAttempts.
   */
  release(id, owner, fence, { proven = false, reason = 'released' } = {}) {
    return tx(this.db, () => {
      const row = this.db.prepare("SELECT * FROM tasks WHERE id=? AND state='working' AND owner=? AND fence=?").get(id, owner, fence);
      if (!row) throw new LedgerError('STALE_OR_ILLEGAL', { id, kind: 'release' });
      if (row.dispatch_started && !proven) throw new LedgerError('RELEASE_AFTER_DISPATCH_DENIED');
      const t = this.now(); const exhausted = row.attempts >= this.maxAttempts;
      this.db.prepare('UPDATE tasks SET state=?, owner=NULL, lease_until=NULL, dispatch_started=0, updated_at=? WHERE id=?').run(exhausted ? STATE.FAILED : STATE.SUBMITTED, t, id);
      this._event(id, exhausted ? 'failed' : 'released', { reason: String(reason).slice(0, 64), proven, attempts: row.attempts });
      return this.get(id);
    });
  }
  /**
   * Crash recovery. Expired lease and nothing dispatched => back to the queue (provably unsent).
   * Expired lease after dispatch started => UNKNOWN. There is no path from here to a resend.
   */
  reap() {
    return tx(this.db, () => {
      const t = this.now(); let requeued = 0, unknown = 0;
      for (const r of this.db.prepare("SELECT * FROM tasks WHERE state='working' AND lease_until<=?").all(t)) {
        if (r.dispatch_started) { this.db.prepare("UPDATE tasks SET state='unknown', updated_at=? WHERE id=?").run(t, r.id); this._event(r.id, 'unknown', { reason: 'lease_expired_after_dispatch', owner: r.owner }); unknown++; }
        else {
          const exhausted = r.attempts >= this.maxAttempts;
          this.db.prepare('UPDATE tasks SET state=?, owner=NULL, lease_until=NULL, updated_at=? WHERE id=?').run(exhausted ? STATE.FAILED : STATE.SUBMITTED, t, r.id);
          this._event(r.id, exhausted ? 'failed' : 'lease_expired_not_dispatched', { owner: r.owner }); requeued++;
        }
      }
      return { requeued, unknown };
    });
  }
  cancel(id) {
    return tx(this.db, () => {
      const t = this.now();
      const r = this.db.prepare("UPDATE tasks SET state='canceled', owner=NULL, updated_at=? WHERE id=? AND state IN ('submitted','input_required')").run(t, id);
      if (r.changes !== 1) throw new LedgerError('STALE_OR_ILLEGAL', { id, kind: 'cancel' });
      this._event(id, 'canceled', {}); return this.get(id);
    });
  }
}

/**
 * Separate handle for a HUMAN who inspected the chat. Deliberately a different class and constructor:
 * dispatchers and adapters are given a Ledger, which cannot resolve UNKNOWN. Re-doing a task means a NEW id.
 */
export class LedgerOperator extends Base {
  constructor(file, operatorId, opts = {}) { super(file, opts); if (!PARTY.test(operatorId ?? '')) throw new LedgerError('OPERATOR_ID_REQUIRED'); this.operatorId = operatorId; }
  resolveUnknown(id, outcome, note) {
    if (!['completed', 'canceled'].includes(outcome) || typeof note !== 'string' || note.length < 3) throw new LedgerError('INVALID_RESOLUTION');
    return tx(this.db, () => {
      const t = this.now();
      const r = this.db.prepare("UPDATE tasks SET state=?, owner=NULL, updated_at=? WHERE id=? AND state='unknown'").run(outcome, t, id);
      if (r.changes !== 1) throw new LedgerError('ONLY_UNKNOWN_CAN_BE_RESOLVED', { id });
      this._event(id, 'operator_resolved', { by: this.operatorId, outcome, note: note.slice(0, 500) });
      return this.get(id);
    });
  }
}
