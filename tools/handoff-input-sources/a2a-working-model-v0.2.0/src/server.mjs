import http from 'node:http';
import crypto from 'node:crypto';
import { Ledger, LedgerError } from './ledger.mjs';

const json = (res, status, body) => {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
};
const safeEqual = (a, b) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
async function readJson(req, maxBytes = 70_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) { const e = new Error('BODY_TOO_LARGE'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const e = new Error('INVALID_JSON'); e.status = 400; throw e; }
}
function publicTask(task) {
  if (!task) return null;
  const { owner, leaseUntil, fence, dispatchStarted, ...safe } = task;
  return safe;
}

/** Minimal authenticated HTTP facade over the durable ledger. Bind to loopback by default. */
export function createA2AServer({ ledger, token, agentName = 'Local A2A Agent', agentUrl = 'http://127.0.0.1:8787', sender = 'client', maxBodyBytes = 70_000 }) {
  if (!(ledger instanceof Ledger) || typeof token !== 'string' || token.length < 24) throw new Error('LEDGER_AND_32_CHAR_TOKEN_REQUIRED');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, agentUrl);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') return json(res, 200, {
        name: agentName, description: 'Local durable task agent with operator-reviewed ambiguous delivery handling.', url: agentUrl,
        version: '0.2.0', protocolVersion: '1.0', preferredTransport: 'JSONRPC',
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
        defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['text/plain', 'application/json'],
        skills: [{ id: 'durable-task', name: 'Durable task submission', description: 'Submit and inspect durable tasks.', tags: ['tasks', 'workflow'], examples: ['Review this change and report findings.'] }]
      });
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) return json(res, 401, { error: 'UNAUTHORIZED' });
      if (req.method === 'POST' && url.pathname === '/v1/tasks') {
        const body = await readJson(req, maxBodyBytes);
        const result = ledger.submit({ id: body.id, contextId: body.contextId, sender, recipient: body.recipient, text: body.text, parentId: body.parentId ?? null });
        if (result.result === 'conflict') return json(res, 409, { error: 'IDEMPOTENCY_CONFLICT' });
        return json(res, result.result === 'created' ? 201 : 200, { result: result.result, task: publicTask(result.task) });
      }
      let match = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9_-]{1,80})(\/events)?$/);
      if (req.method === 'GET' && match) {
        const task = ledger.get(match[1]);
        if (!task) return json(res, 404, { error: 'TASK_NOT_FOUND' });
        if (match[2]) return json(res, 200, { taskId: task.id, events: ledger.events(task.id) });
        return json(res, 200, { task: publicTask(task) });
      }
      if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9_-]{1,80})\/cancel$/))) {
        return json(res, 200, { task: publicTask(ledger.cancel(match[1])) });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      if (e instanceof LedgerError) {
        const status = e.code === 'INVALID_TASK' ? 400 : e.code === 'BUDGET_EXCEEDED' || e.code === 'DEPTH_LIMIT' ? 422 : e.code === 'STALE_OR_ILLEGAL' ? 409 : 400;
        return json(res, status, { error: e.code, detail: e.detail });
      }
      return json(res, e.status ?? 500, { error: e.status ? e.message : 'INTERNAL_ERROR' });
    }
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.A2A_DB;
  const token = process.env.A2A_API_TOKEN;
  const host = process.env.A2A_HOST ?? '127.0.0.1';
  const port = Number(process.env.A2A_PORT ?? 8787);
  if (!dbPath || !token || token.length < 24) {
    console.error('Set A2A_DB to an absolute path and A2A_API_TOKEN to a secret of at least 24 characters.'); process.exit(2);
  }
  const ledger = new Ledger(dbPath);
  const server = createA2AServer({ ledger, token, agentUrl: `http://${host}:${port}` });
  server.listen(port, host, () => console.log(`A2A API listening at http://${host}:${port}`));
  const shutdown = () => server.close(() => { ledger.close(); process.exit(0); });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
