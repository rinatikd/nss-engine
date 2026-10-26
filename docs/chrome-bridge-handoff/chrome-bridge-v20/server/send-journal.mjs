import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const AGENT = /^[a-z0-9_-]{1,32}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const STATUS = new Set(['UNKNOWN', 'CONFIRMED', 'NOT_PERFORMED', 'BLOCKED']);
const ORIGINS = new Set(['https://claude.ai', 'https://gemini.google.com', 'https://chat.deepseek.com']);
const MAX_ENTRIES = 10000;
export const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const copy = (entry) => entry ? { ...entry } : null;

// Write-ahead journal. It stores only an HMAC fingerprint and transport metadata,
// never message bodies, auth tokens, or AI replies. A stale lock fails closed.
export class SendJournal {
  constructor(stateDir, { hmacKey, fsOps = fs, maxBytes = MAX_JOURNAL_BYTES } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw Error('JOURNAL_DIR_REQUIRED');
    if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) throw Error('JOURNAL_HMAC_KEY_REQUIRED');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 64 * 1024 * 1024) throw Error('JOURNAL_INVALID_SIZE_LIMIT');
    this.fs = fsOps;
    this.maxBytes = maxBytes;
    this.fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = path.join(stateDir, 'send-journal.json');
    this.lockFile = this.file + '.lock';
    this.hmacKey = Buffer.from(hmacKey);
    this.#read();
  }
  #read() {
    let stat;
    try { stat = this.fs.lstatSync(this.file); }
    catch (error) { if (error.code === 'ENOENT') return new Map(); throw Error('JOURNAL_READ_FAILED'); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('JOURNAL_CORRUPT_FAIL_CLOSED');
    if (stat.size > this.maxBytes) throw Error('JOURNAL_TOO_LARGE_FAIL_CLOSED');
    try {
      const x = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (![1, 2].includes(x?.version) || !x.entries || typeof x.entries !== 'object' || Array.isArray(x.entries)) throw Error();
      const entries = new Map(Object.entries(x.entries).map(([id, entry]) => [id, x.version === 1
        ? { ...entry, identityVersion: 1, payloadFingerprint: entry?.fingerprint, origin: null, conversationFingerprint: null }
        : entry]));
      if (entries.size > MAX_ENTRIES) throw Error();
      for (const [id, entry] of entries) {
        if (!ID.test(id) || entry?.requestId !== id || !AGENT.test(entry.agent || '') ||
            !Number.isSafeInteger(entry.tabId) || entry.tabId <= 0 || !FINGERPRINT.test(entry.fingerprint || '') ||
            (entry.identityVersion === 2 && (!ORIGINS.has(entry.origin) || !FINGERPRINT.test(entry.conversationFingerprint || '') || !FINGERPRINT.test(entry.payloadFingerprint || ''))) ||
            (entry.identityVersion !== 1 && entry.identityVersion !== 2) ||
            !STATUS.has(entry.status) || typeof entry.createdAt !== 'string' ||
            !(entry.baseline === null || (Number.isSafeInteger(entry.baseline) && entry.baseline >= 0)) ||
            !(entry.transportConfirmed === null || typeof entry.transportConfirmed === 'boolean')) throw Error();
      }
      return entries;
    } catch { throw Error('JOURNAL_CORRUPT_FAIL_CLOSED'); }
  }
  #write(entries) {
    if (entries.size > MAX_ENTRIES) throw Error('JOURNAL_FULL_FAIL_CLOSED');
    const payload = JSON.stringify({ version: 2, entries: Object.fromEntries(entries) });
    if (Buffer.byteLength(payload, 'utf8') > this.maxBytes) throw Error('JOURNAL_TOO_LARGE_FAIL_CLOSED');
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fd = this.fs.openSync(tmp, 'wx', 0o600);
      this.fs.writeFileSync(fd, payload);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd); fd = undefined;
      this.fs.renameSync(tmp, this.file);
    } finally {
      if (fd !== undefined) try { this.fs.closeSync(fd); } catch {}
      try { this.fs.unlinkSync(tmp); } catch {}
    }
  }
  #transact(change) {
    let lock;
    try { lock = this.fs.openSync(this.lockFile, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Error('JOURNAL_BUSY_FAIL_CLOSED'); throw Error('JOURNAL_LOCK_FAILED'); }
    try {
      this.fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      this.fs.fsyncSync(lock);
      const entries = this.#read();
      const result = change(entries);
      if (result.write) this.#write(entries);
      return result.value;
    } finally {
      try { this.fs.closeSync(lock); } catch {}
      try { this.fs.unlinkSync(this.lockFile); } catch {}
    }
  }
  begin({ requestId, agent, tabId, origin, conversationFingerprint, fingerprint, payloadFingerprint }) {
    if (typeof requestId !== 'string' || !ID.test(requestId) || typeof agent !== 'string' || !AGENT.test(agent) ||
        !Number.isSafeInteger(tabId) || tabId <= 0 || !ORIGINS.has(origin) ||
        typeof conversationFingerprint !== 'string' || !FINGERPRINT.test(conversationFingerprint) ||
        typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint) ||
        typeof payloadFingerprint !== 'string' || !FINGERPRINT.test(payloadFingerprint))
      throw Error('JOURNAL_INVALID_INPUT');
    return this.#transact((entries) => {
      const old = entries.get(requestId);
      if (old) {
        if (old.agent !== agent || old.tabId !== tabId) throw Error('SEND_ID_CONFLICT');
        if (old.identityVersion === 1) {
          if (old.fingerprint !== payloadFingerprint) throw Error('SEND_ID_CONFLICT');
          return { value: { entry: copy(old), duplicate: true, legacyIdentity: true }, write: false };
        }
        if (old.payloadFingerprint !== payloadFingerprint || old.origin !== origin ||
            old.conversationFingerprint !== conversationFingerprint || old.fingerprint !== fingerprint) throw Error('SEND_ID_CONFLICT');
        return { value: { entry: copy(old), duplicate: true }, write: false };
      }
      if (entries.size >= MAX_ENTRIES) throw Error('JOURNAL_FULL_FAIL_CLOSED');
      const entry = { requestId, agent, tabId, origin, conversationFingerprint, identityVersion: 2,
        fingerprint, payloadFingerprint, status: 'UNKNOWN', baseline: null, transportConfirmed: null, createdAt: new Date().toISOString() };
      entries.set(requestId, entry);
      return { value: { entry: copy(entry), duplicate: false }, write: true };
    });
  }
  settle(requestId, status, metadata = {}) {
    if (!STATUS.has(status) || (metadata.baseline !== undefined && metadata.baseline !== null && (!Number.isSafeInteger(metadata.baseline) || metadata.baseline < 0)) ||
        (metadata.transportConfirmed !== undefined && typeof metadata.transportConfirmed !== 'boolean')) throw Error('JOURNAL_INVALID_STATUS');
    return this.#transact((entries) => {
      const old = entries.get(requestId);
      if (!old) throw Error('JOURNAL_ID_UNKNOWN');
      if (old.status !== 'UNKNOWN' && old.status !== status) throw Error('JOURNAL_TERMINAL_STATUS');
      const entry = { ...old, status,
        ...(metadata.baseline !== undefined ? { baseline: metadata.baseline } : {}),
        ...(metadata.transportConfirmed !== undefined ? { transportConfirmed: metadata.transportConfirmed } : {}) };
      entries.set(requestId, entry);
      return { value: copy(entry), write: true };
    });
  }
  get(id) { return copy(this.#read().get(id)); }
}

export function legacyRequestFingerprint(agent, tabId, text, hmacKey) {
  if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) throw Error('JOURNAL_HMAC_KEY_REQUIRED');
  return crypto.createHmac('sha256', hmacKey).update(JSON.stringify([agent, tabId, text]), 'utf8').digest('hex');
}

export function conversationFingerprint(origin, conversationId, hmacKey) {
  if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) throw Error('JOURNAL_HMAC_KEY_REQUIRED');
  if (!ORIGINS.has(origin) || typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(conversationId)) throw Error('JOURNAL_INVALID_CONTEXT');
  return crypto.createHmac('sha256', hmacKey).update(JSON.stringify(['chrome-bridge/conversation/v1', origin, conversationId]), 'utf8').digest('hex');
}

export function requestFingerprint(agent, tabId, text, hmacKey, { origin, conversationId } = {}) {
  if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) throw Error('JOURNAL_HMAC_KEY_REQUIRED');
  if (!ORIGINS.has(origin) || typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(conversationId)) throw Error('JOURNAL_INVALID_CONTEXT');
  return crypto.createHmac('sha256', hmacKey).update(JSON.stringify(['chrome-bridge/send/v2', agent, tabId, origin, conversationId, text]), 'utf8').digest('hex');
}

