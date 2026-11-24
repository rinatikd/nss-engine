import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventLedger } from './event-ledger.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(ROOT, 'web');
const ACTOR_TOKENS = [
  ['CONSILIUM_OWNER_TOKEN', { id: 'owner', role: 'owner' }],
  ['CONSILIUM_CHATGPT_TOKEN', { id: 'chatgpt', role: 'ai_member' }],
  ['CONSILIUM_CLAUDE_TOKEN', { id: 'claude', role: 'ai_member' }],
  ['CONSILIUM_DEEPSEEK_TOKEN', { id: 'deepseek', role: 'ai_member' }],
  ['CONSILIUM_QWEN_TOKEN', { id: 'qwen', role: 'ai_member' }],
  ['CONSILIUM_KIMI_TOKEN', { id: 'kimi', role: 'ai_member' }],
  ['CONSILIUM_GROK_TOKEN', { id: 'grok', role: 'ai_member' }],
  ['CONSILIUM_GEMINI_TOKEN', { id: 'gemini', role: 'ai_member' }]
];
const TOKEN_MIN = 32;
const ACTOR_ROLES = { owner: 'owner', chatgpt: 'ai_member', claude: 'ai_member', deepseek: 'ai_member', qwen: 'ai_member', kimi: 'ai_member', grok: 'ai_member', gemini: 'ai_member' };
const MAX_BODY = 128 * 1024;
const SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}/i;

function safeEqual(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  });
  res.end(JSON.stringify(value));
}
function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) { reject(Error('BODY_TOO_LARGE')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Error('INVALID_JSON')); }
    });
    req.on('error', () => reject(Error('REQUEST_READ_FAILED')));
  });
}
function validString(x, max = 4000) { return typeof x === 'string' && x.trim().length > 0 && x.length <= max; }
function validId(x) { return typeof x === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(x); }
function rejectSecrets(value) {
  if (SECRET.test(typeof value === 'string' ? value : JSON.stringify(value))) throw Error('SECRET_LIKE_CONTENT_REJECTED');
}
function actorFor(req, tokens) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) return null;
  for (const item of tokens) if (safeEqual(match[1], item.token)) return item.actor;
  return null;
}
function requireRole(actor, allowed) {
  if (!actor || !allowed.includes(actor.role)) throw Error('FORBIDDEN');
}
function requestId(body) { return body.requestId; }

export function loadActorTokens(env = process.env) {
  const result = [];
  const seen = new Set();
  for (const [key, actor] of ACTOR_TOKENS) {
    const token = env[key];
    if (!token) continue;
    if (token.length < TOKEN_MIN || seen.has(token)) throw Error('ACTOR_TOKEN_INVALID_OR_REUSED');
    seen.add(token); result.push({ token, actor });
  }
  for (const id of ['owner', 'chatgpt', 'claude', 'deepseek', 'qwen', 'kimi', 'grok', 'gemini']) {
    if (!result.some(x => x.actor.id === id)) throw Error('REQUIRED_IDENTITY_TOKEN_MISSING_' + id.toUpperCase());
  }
  return result;
}

export function createControlRoom({ dataDir, tokens, port = 0, host = '127.0.0.1', now } = {}) {
  if (host !== '127.0.0.1') throw Error('LOOPBACK_ONLY');
  if (!Array.isArray(tokens) || !['owner', 'chatgpt', 'claude', 'deepseek', 'qwen', 'kimi', 'grok', 'gemini'].every(id => tokens.some(x => x.actor?.id === id))) throw Error('FULL_COUNCIL_IDENTITIES_REQUIRED');
  const identities = new Set(), secrets = new Set();
  for (const x of tokens) {
    if (typeof x.token !== 'string' || x.token.length < TOKEN_MIN || secrets.has(x.token)) throw Error('ACTOR_TOKEN_INVALID_OR_REUSED');
    if (!x.actor || identities.has(x.actor.id)) throw Error('ACTOR_IDENTITY_DUPLICATE');
    const requiredRole = ACTOR_ROLES[x.actor?.id];
    if (!requiredRole || x.actor.role !== requiredRole) throw Error('ACTOR_ROLE_MISMATCH');
    identities.add(x.actor.id); secrets.add(x.token);
  }
  const ledger = new EventLedger(dataDir, { now });
  let server;
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

  const handle = async (req, res) => {
    try {
      const address = server.address();
      const expectedHost = `127.0.0.1:${address.port}`;
      if (req.headers.host !== expectedHost) return json(res, 403, { error: 'HOST_DENIED' });
      const url = new URL(req.url, `http://${expectedHost}`);
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, bind: host, port: address.port });
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const full = path.join(UI_ROOT, file);
        return text(res, 200, fs.readFileSync(full, 'utf8'), mime[path.extname(full)]);
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
      const actor = actorFor(req, tokens);
      if (!actor) return json(res, 401, { error: 'AUTH_REQUIRED' });
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const payload = ledger.exportNdjson();
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-disposition': 'attachment; filename="consilium-events.ndjson"',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer'
        });
        res.end(payload);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const after = Number(url.searchParams.get('after') || 0);
        const limit = Number(url.searchParams.get('limit') || 1000);
        const events = ledger.list({ after, limit });
        return json(res, 200, { events, nextAfter: events.at(-1)?.seq || after, hasMore: events.length === limit });
      }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        const snapshot = ledger.snapshot({ after: Number(url.searchParams.get('after') || 0), limit: 2000 });
        return json(res, 200, { actor, ...snapshot });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      const origin = req.headers.origin;
      if (origin !== `http://${expectedHost}`) return json(res, 403, { error: 'ORIGIN_DENIED' });
      const body = await readBody(req);
      rejectSecrets(body);
      if (!validId(requestId(body))) throw Error('INVALID_REQUEST_ID');
      const id = requestId(body);
      const append = (type, payload) => ledger.append({ type, actor, payload, requestId: id });
      if (url.pathname === '/api/session/start') {
        requireRole(actor, ['owner', 'ai_member']);
        if (!validString(body.title, 180)) throw Error('INVALID_TITLE');
        const event = append('session.started', { sessionId: crypto.randomUUID(), title: body.title.trim() });
        return json(res, 201, { event });
      }
      if (url.pathname === '/api/session/pause') {
        requireRole(actor, ['owner', 'ai_member']);
        return json(res, 200, { event: append('session.paused', { reason: body.reason || 'member_pause' }) });
      }
      if (url.pathname === '/api/session/resume') {
        requireRole(actor, ['owner', 'ai_member']);
        return json(res, 200, { event: append('session.resumed', { reason: body.reason || 'member_resume' }) });
      }
      if (url.pathname === '/api/session/stop') {
        requireRole(actor, ['owner', 'ai_member']);
        return json(res, 202, { event: append('session.stop_requested', { reason: body.reason || 'member_stop', guarantee: 'new orchestrator dispatch is blocked; Bridge in-flight cancellation requires the fencing adapter' }) });
      }
      if (url.pathname === '/api/session/stop-confirmed') {
        return json(res, 503, { error: 'BRIDGE_QUIESCENCE_ADAPTER_NOT_CONFIGURED' });
      }
      if (url.pathname === '/api/comments') {
        if (!validString(body.text, 12000)) throw Error('INVALID_COMMENT');
        return json(res, 201, { event: append('comment.added', { text: body.text.trim(), replyTo: body.replyTo || null }) });
      }
      if (url.pathname === '/api/messages') {
        if (['REPLIED', 'VERIFIED'].includes(body.deliveryStatus)) throw Error('PROVIDER_REPLY_RECEIPT_REQUIRED');
        if (!validString(body.provider, 32) || !validString(body.text, 40000) || !validString(body.requestId, 100) || !['ACCEPTED', 'DISPATCHED', 'SENT', 'DELIVERED', 'UNKNOWN', 'NOT_PERFORMED', 'BLOCKED', 'FAILED'].includes(body.deliveryStatus || 'UNKNOWN')) throw Error('INVALID_MESSAGE');
        return json(res, 201, { event: append('message.recorded', { provider: body.provider, text: body.text, deliveryStatus: body.deliveryStatus || 'UNKNOWN', providerRequestId: body.requestId, sourceCommit: body.sourceCommit || null, evidenceClass: 'caller-assertion-not-provider-receipt' }) });
      }
      if (url.pathname === '/api/rounds/propose') {
        requireRole(actor, ['ai_member']);
        if (!validId(body.roundId) || !validString(body.objective, 500) || !Array.isArray(body.participants) || !body.participants.length || body.participants.length > 7 || body.participants.some(x => !['chatgpt', 'claude', 'deepseek', 'qwen', 'kimi', 'grok', 'gemini'].includes(x)) || new Set(body.participants).size !== body.participants.length) throw Error('INVALID_ROUND_PROPOSAL');
        return json(res, 201, { event: append('round.proposed', { roundId: body.roundId, objective: body.objective.trim(), participants: body.participants.slice(), proposedBy: actor.id }) });
      }
      if (url.pathname === '/api/rounds/start') {
        requireRole(actor, ['ai_member']);
        if (!validId(body.roundId)) throw Error('INVALID_ROUND_ID');
        return json(res, 202, { event: append('round.started', { roundId: body.roundId, startedBy: actor.id }) });
      }
      if (url.pathname === '/api/decisions') {
        requireRole(actor, ['owner', 'ai_member']);
        if (!validString(body.title, 180) || !validString(body.rationale, 12000) || !Array.isArray(body.evidence || []) || !['routine', 'consequential'].includes(body.risk || 'consequential')) throw Error('INVALID_DECISION');
        const decisionId = body.decisionId || crypto.randomUUID();
        return json(res, 201, { event: append('decision.proposed', { decisionId, title: body.title.trim(), rationale: body.rationale.trim(), risk: body.risk || 'consequential', evidence: (body.evidence || []).slice(0, 50) }) });
      }
      if (url.pathname === '/api/decisions/review') {
        requireRole(actor, ['ai_member']);
        if (!validId(body.decisionId) || !['SUPPORT', 'OBJECT', 'NEEDS_EVIDENCE'].includes(body.verdict) || !validString(body.rationale, 4000) || (body.revisionOf && !validId(body.revisionOf)) || !Array.isArray(body.evidence || []) || (body.evidence || []).length > 20 || (body.evidence || []).some(x => !validString(x, 2000))) throw Error('INVALID_DECISION_REVIEW');
        return json(res, 201, { event: append('decision.reviewed', { decisionId: body.decisionId, verdict: body.verdict, rationale: body.rationale.trim(), evidence: (body.evidence || []).slice(0, 20), revisionOf: body.revisionOf || null }) });
      }
      if (url.pathname === '/api/decisions/approve') {
        requireRole(actor, ['owner']);
        if (!validId(body.decisionId)) throw Error('INVALID_DECISION_ID');
        return json(res, 200, { event: append('decision.owner_approved', { decisionId: body.decisionId }) });
      }
      if (url.pathname === '/api/decisions/reject') {
        requireRole(actor, ['owner']);
        if (!validId(body.decisionId) || !validString(body.reason, 2000)) throw Error('INVALID_DECISION_REJECTION');
        return json(res, 200, { event: append('decision.rejected', { decisionId: body.decisionId, reason: body.reason }) });
      }
      if (url.pathname === '/api/artifacts') {
        requireRole(actor, ['owner', 'ai_member']);
        if (!validId(body.artifactId) || !validString(body.name, 180) || !/^[a-f0-9]{64}$/.test(body.sha256 || '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(body.sourceCommit || '') || !validString(body.uri, 2000) || !/^https?:\/\//i.test(body.uri) || !Array.isArray(body.recipients) || !body.recipients.length || body.recipients.length > 16 || body.recipients.some(x => !/^[a-z][a-z0-9_-]{1,31}$/.test(x)) || new Set(body.recipients).size !== body.recipients.length) throw Error('INVALID_ARTIFACT_MANIFEST');
        return json(res, 201, { event: append('artifact.linked', { artifactId: body.artifactId, name: body.name, sha256: body.sha256, sourceCommit: body.sourceCommit, uri: body.uri, recipients: body.recipients.slice(0, 16) }) });
      }
      if (url.pathname === '/api/artifacts/receipt') {
        if (!validId(body.artifactId) || !/^[a-f0-9]{64}$/.test(body.sha256 || '') || !validString(body.receiptId, 100)) throw Error('INVALID_ARTIFACT_RECEIPT');
        return json(res, 201, { event: append('artifact.received', { artifactId: body.artifactId, sha256: body.sha256, receiptId: body.receiptId }) });
      }
      if (url.pathname === '/api/tasks') {
        requireRole(actor, ['owner', 'ai_member']);
        if (!validId(body.taskId) || !validId(body.decisionId) || !validString(body.title, 180) || !validString(body.assignee, 32)) throw Error('INVALID_TASK');
        return json(res, 201, { event: append('task.created', { taskId: body.taskId, decisionId: body.decisionId, title: body.title.trim(), assignee: body.assignee }) });
      }
      if (url.pathname === '/api/tasks/state') {
        requireRole(actor, ['owner', 'ai_member']);
        if (!validId(body.taskId) || !validString(body.status, 32)) throw Error('INVALID_TASK_STATE');
        const task = ledger.snapshot().state.tasks.find(x => x.id === body.taskId);
        if (!task) throw Error('TASK_NOT_FOUND');
        const commitSha = body.commitSha || null;
        const evidence = body.evidence || [];
        if (!Array.isArray(evidence) || evidence.length > 50 || evidence.some(x => !validString(x, 2000))) throw Error('INVALID_TASK_EVIDENCE');
        if (body.status === 'VERIFIED' && (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha || '') || !evidence.length)) throw Error('VERIFICATION_EVIDENCE_REQUIRED');
        if (commitSha && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)) throw Error('INVALID_COMMIT_SHA');
        return json(res, 200, { event: append('task.state_changed', { taskId: body.taskId, status: body.status, commitSha, evidence }) });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const code = /^[A-Z0-9_]{3,80}$/.test(error?.message || '') ? error.message : 'REQUEST_FAILED';
      const status = ['FORBIDDEN', 'TASK_ASSIGNEE_REQUIRED', 'ORIGIN_DENIED', 'HOST_DENIED'].includes(code) ? 403 :
        ['AUTH_REQUIRED'].includes(code) ? 401 :
        ['NOT_FOUND'].includes(code) ? 404 : 400;
      return json(res, status, { error: code });
    }
  };
  server = http.createServer((req, res) => { void handle(req, res); });
  return {
    server, ledger,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return { host, port: server.address().port };
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      ledger.close();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.CONSILIUM_DATA_DIR || path.resolve('data/consilium');
  const port = Number(process.env.CONSILIUM_PORT || 18765);
  const tokens = loadActorTokens();
  const app = createControlRoom({ dataDir, tokens, port });
  const address = await app.listen();
  process.stdout.write(`CONSILIUM_CONTROL_ROOM_READY http://${address.host}:${address.port}/\\n`);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
