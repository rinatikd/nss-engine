import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ledger, LedgerError } from './ledger.mjs';

const json = (res, status, body, contentType = 'application/json; charset=utf-8', extraHeaders = {}) => {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': contentType, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
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

function a2aTask(ledger, task) {
  const stateMap = { submitted: 'submitted', working: 'working', input_required: 'input-required', completed: 'completed', failed: 'failed', canceled: 'canceled', unknown: 'unknown' };
  const events = ledger.events(task.id);
  const completion = [...events].reverse().find(e => e.kind === 'completed');
  const input = [...events].reverse().find(e => e.kind === 'input_required');
  const artifacts = completion?.body?.artifact ? [{ artifactId: `artifact-${task.id}`, name: 'response.txt', parts: [{ kind: 'text', text: completion.body.artifact.text }], metadata: completion.body.artifact.meta ?? {} }] : [];
  const status = { state: stateMap[task.state] ?? 'failed', timestamp: new Date(task.updatedAt).toISOString() };
  if (input?.body?.question) status.message = { messageId: `status-${task.id}`, role: 'agent', parts: [{ kind: 'text', text: input.body.question }] };
  return { id: task.id, contextId: task.contextId, status, ...(artifacts.length ? { artifacts } : {}), ...(task.parentId ? { metadata: { parentId: task.parentId } } : {}) };
}

/** Minimal authenticated HTTP facade over the durable ledger. Bind to loopback by default. */
export function createA2AServer({ ledger, token, agentName = 'Local A2A Agent', agentUrl = 'http://127.0.0.1:8787', sender = 'client', defaultRecipient = 'claude', maxBodyBytes = 70_000, health = () => ({ ok: true }) }) {
  if (!(ledger instanceof Ledger) || typeof token !== 'string' || token.length < 24) throw new Error('LEDGER_AND_32_CHAR_TOKEN_REQUIRED');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, agentUrl);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, health());
      if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') return json(res, 200, {
        name: agentName, description: 'Durable A2A task gateway with operator-reviewed ambiguous delivery handling.',
        version: '0.4.0', protocolVersion: '1.0', supportedInterfaces: [{ url: agentUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque-token' } },
        securityRequirements: [{ bearerAuth: [] }],
        skills: [{ id: 'durable-task', name: 'Durable task delegation', description: 'Submit text tasks to a configured downstream agent and inspect durable task status.', tags: ['tasks', 'delegation'], examples: ['Review this change and report findings.'], inputModes: ['text/plain'], outputModes: ['text/plain'] }]
      });
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) return json(res, 401, { error: 'UNAUTHORIZED' });
      // A2A v1 JSON-RPC binding. The existing /v1/tasks routes remain as a project-specific admin facade.
      if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/a2a')) {
        const rpc = await readJson(req, maxBodyBytes);
        const rpcId = rpc && Object.hasOwn(rpc, 'id') ? rpc.id : null;
        const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: rpcId, result }, 'application/a2a+json; charset=utf-8', { 'A2A-Version': '1.0' });
        const rpcError = (code, message, data) => json(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code, message, ...(data === undefined ? {} : { data }) } }, 'application/a2a+json; charset=utf-8', { 'A2A-Version': '1.0' });
        if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || !Object.hasOwn(rpc, 'id') || rpc.id === null || !['string','number'].includes(typeof rpc.id) || (typeof rpc.id === 'number' && !Number.isInteger(rpc.id))) return rpcError(-32600, 'Invalid Request');
        const params = rpc.params ?? {};
        if (!params || typeof params !== 'object' || Array.isArray(params)) return rpcError(-32602, 'Invalid params');
        try {
          if (rpc.method === 'message/send') {
            const msg = params.message;
            if (!msg || typeof msg !== 'object' || msg.role !== 'user' || !Array.isArray(msg.parts) || msg.parts.length < 1) return rpcError(-32602, 'message must have role=user and at least one part');
            const textParts = msg.parts.filter(p => p && (p.kind === 'text' || p.type === 'text') && typeof p.text === 'string');
            if (textParts.length !== msg.parts.length || textParts.some(p => !p.text.trim())) return rpcError(-32602, 'Only non-empty text parts are supported');
            const textBody = textParts.map(p => p.text).join('\n');
            const contextId = msg.contextId ?? crypto.randomUUID();
            const taskId = msg.taskId ?? crypto.randomUUID();
            const recipient = params.metadata?.recipient ?? msg.metadata?.recipient ?? defaultRecipient;
            const submitted = ledger.submit({ id: taskId, contextId, sender, recipient, text: textBody, parentId: msg.metadata?.parentId ?? null });
            if (submitted.result === 'conflict') return rpcError(-32009, 'Task id conflicts with existing content', { taskId });
            return reply(a2aTask(ledger, submitted.task));
          }
          if (rpc.method === 'tasks/list') {
            const pageSize = params.pageSize ?? 50;
            const listed = ledger.listTasks({ contextId: params.contextId ?? null, status: params.status ?? null, pageSize, pageToken: params.pageToken || null });
            return reply({ tasks: listed.tasks.map(task => a2aTask(ledger, task)), nextPageToken: listed.nextPageToken });
          }
          if (rpc.method === 'tasks/get') {
            if (typeof params.id !== 'string') return rpcError(-32602, 'id is required');
            const task = ledger.get(params.id);
            if (!task) return rpcError(-32001, 'Task not found', { id: params.id });
            return reply(a2aTask(ledger, task));
          }
          if (rpc.method === 'tasks/cancel') {
            if (typeof params.id !== 'string') return rpcError(-32602, 'id is required');
            try { return reply(a2aTask(ledger, ledger.cancel(params.id))); }
            catch (e) { if (e instanceof LedgerError && e.code === 'STALE_OR_ILLEGAL') return rpcError(-32002, 'Task cannot be canceled in its current state', { id: params.id, state: ledger.get(params.id)?.state }); throw e; }
          }
          return rpcError(-32601, 'Method not found');
        } catch (e) {
          if (e instanceof LedgerError) return rpcError(-32602, 'Invalid task parameters', { code: e.code, detail: e.detail });
          throw e;
        }
      }
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dbPath = process.env.A2A_DB;
  const token = process.env.A2A_API_TOKEN;
  const host = process.env.A2A_HOST ?? '127.0.0.1';
  const port = Number(process.env.A2A_PORT ?? 8787);
  if (!dbPath || !token || token.length < 24) {
    console.error('Set A2A_DB to an absolute path and A2A_API_TOKEN to a secret of at least 24 characters.'); process.exit(2);
  }
  const ledger = new Ledger(dbPath);
  const server = createA2AServer({ ledger, token, agentUrl: `http://${host}:${port}`, defaultRecipient: process.env.A2A_DEFAULT_RECIPIENT ?? 'claude' });
  server.listen(port, host, () => console.log(`A2A API listening at http://${host}:${port}`));
  const shutdown = () => server.close(() => { ledger.close(); process.exit(0); });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
