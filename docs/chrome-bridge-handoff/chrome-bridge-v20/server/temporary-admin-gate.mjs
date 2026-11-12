// Experimental, opt-in local approval gate for development Codex jobs.
// This module does NOT enable Codex execution or bypass the fail-closed loader.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';

export const MAX_SESSION_MS = 30 * 60 * 1000;
export const MAX_JOB_MS = 5 * 60 * 1000;

export function createTemporaryAdminGate({
  now = () => Date.now(),
  approve = async () => false,
  audit = () => {},
  maxSessionMs = MAX_SESSION_MS,
} = {}) {
  if (!Number.isSafeInteger(maxSessionMs) || maxSessionMs <= 0 || maxSessionMs > MAX_SESSION_MS) {
    throw Error('INVALID_SESSION_TTL');
  }
  let session = null;
  let generation = 0;
  const tickets = new Map();
  const invalidate = () => { tickets.clear(); };
  const record = (event, fields = {}) => audit({ at: now(), event, ...fields });
  return {
    async enable({ localOperator = false } = {}) {
      if (!localOperator) throw Error('LOCAL_OPERATOR_REQUIRED');
      const approvalGeneration = ++generation;
      if (!(await approve({ kind: 'enable', expiresInMs: maxSessionMs }))) {
        record('enable_denied'); return false;
      }
      if (generation !== approvalGeneration) throw Error('ADMIN_APPROVAL_REVOKED');
      invalidate();
      session = { id: crypto.randomUUID(), expiresAt: now() + maxSessionMs };
      record('enabled', { sessionId: session.id, expiresAt: session.expiresAt });
      return true;
    },
    status() {
      return { enabled: !!session && now() < session.expiresAt,
        expiresAt: session?.expiresAt ?? null };
    },
    async authorizeJob({ requestId, workspace, prompt, timeoutSec = 120 }) {
      if (!session || now() >= session.expiresAt) {
        session = null; invalidate(); throw Error('ADMIN_SESSION_INACTIVE');
      }
      if (typeof requestId !== 'string' || !requestId ||
          typeof workspace !== 'string' || !workspace ||
          typeof prompt !== 'string' || !prompt ||
          !Number.isSafeInteger(timeoutSec) || timeoutSec < 1 ||
          timeoutSec * 1000 > MAX_JOB_MS) throw Error('INVALID_ADMIN_JOB');
      // Never put prompt contents, paths to secrets, or environment values in audit logs.
      const approvedSessionId = session.id;
      const requestHash = crypto.createHash('sha256').update(requestId).digest('hex');
      const approved = await approve({ kind: 'job', requestHash, workspace, timeoutSec });
      record(approved ? 'job_approved' : 'job_denied', { requestHash, timeoutSec });
      if (!approved) throw Error('LOCAL_JOB_APPROVAL_REQUIRED');
      if (!session || session.id !== approvedSessionId || now() >= session.expiresAt) {
        record('job_approval_stale', { requestHash });
        throw Error('ADMIN_SESSION_INACTIVE');
      }
      // Opaque one-shot ticket bound to this exact request and approved job parameters.
      const ticket = crypto.randomBytes(32).toString('hex');
      const expiresAt = Math.min(session.expiresAt, now() + timeoutSec * 1000);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([requestId, workspace, prompt, timeoutSec])).digest('hex');
      tickets.set(ticket, { sessionId: session.id, fingerprint, expiresAt });
      return { ticket, expiresAt };
    },
    consumeJob({ ticket, requestId, workspace, prompt, timeoutSec = 120 }) {
      const grant = tickets.get(ticket);
      // Consume before validating to prevent replay after a failed attempt.
      tickets.delete(ticket);
      if (!grant || !session || now() >= session.expiresAt || now() >= grant.expiresAt || grant.sessionId !== session.id) {
        record('ticket_rejected'); throw Error('ADMIN_TICKET_INVALID');
      }
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([requestId, workspace, prompt, timeoutSec])).digest('hex');
      if (fingerprint !== grant.fingerprint) {
        record('ticket_mismatch'); throw Error('ADMIN_TICKET_MISMATCH');
      }
      record('ticket_consumed');
      return true;
    },
    disable() {
      if (session) record('disabled', { sessionId: session.id });
      session = null;
      generation++;
      invalidate();
    },
  };
}

// This prompt must run on the local operator console, not through MCP/chat.
export async function confirmOnLocalConsole({ kind, workspace, timeoutSec, expiresInMs }) {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const label = kind === 'enable'
      ? `ENABLE temporary admin session for ${Math.ceil(expiresInMs / 60000)} minutes`
      : `APPROVE one Codex job in ${workspace} (max ${timeoutSec}s)`;
    const answer = await rl.question(`[LOCAL OPERATOR] ${label}. Type APPROVE: `);
    return answer.trim() === 'APPROVE';
  } finally { rl.close(); }
}
