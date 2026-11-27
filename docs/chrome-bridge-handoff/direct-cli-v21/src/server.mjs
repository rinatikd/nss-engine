import readline from 'node:readline';

const tools = [
  { name: 'codex_submit', description: 'Submit a local Codex CLI job in an operator-approved isolated workspace. Execution is disabled unless an independently verified runner is configured.', inputSchema: { type: 'object', properties: { requestId: { type: 'string', minLength: 1, maxLength: 80 }, workspace: { type: 'string', minLength: 1, maxLength: 32 }, prompt: { type: 'string', minLength: 1, maxLength: 32768 }, timeoutSec: { type: 'integer', minimum: 1, maximum: 300 } }, required: ['requestId', 'workspace', 'prompt'], additionalProperties: false } },
  { name: 'codex_job', description: 'Read a local Codex job status. This prototype has execution disabled, so no jobs can be created.', inputSchema: { type: 'object', properties: { jobId: { type: 'string', minLength: 1, maxLength: 64 }, waitSec: { type: 'integer', minimum: 0, maximum: 25 } }, required: ['jobId'], additionalProperties: false } },
  { name: 'codex_cancel', description: 'Cancel a local Codex job. This prototype has execution disabled, so no jobs can be created.', inputSchema: { type: 'object', properties: { jobId: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['jobId'], additionalProperties: false } },
];
const known = new Set(tools.map(t => t.name));
function response(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }
function validate(name, args) {
  const schema = tools.find(t => t.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) throw Error('INVALID_ARGUMENTS');
  const props = schema.properties;
  if (Object.keys(args).some(k => !Object.hasOwn(props, k))) throw Error('INVALID_ARGUMENTS');
  if (schema.required.some(k => !Object.hasOwn(args, k))) throw Error('INVALID_ARGUMENTS');
  for (const [k, v] of Object.entries(args)) {
    const s = props[k];
    if (s.type === 'string' && (typeof v !== 'string' || v.length < (s.minLength || 0) || v.length > s.maxLength)) throw Error('INVALID_ARGUMENTS');
    if (s.type === 'integer' && (!Number.isInteger(v) || v < s.minimum || v > s.maximum)) throw Error('INVALID_ARGUMENTS');
  }
}
async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return;
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    return response(msg.id, { protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'direct-local-codex-mcp', version: '0.1.0' } });
  }
  if (msg.method === 'ping') return response(msg.id, {});
  if (msg.method === 'tools/list') return response(msg.id, { tools });
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (!known.has(name)) return error(msg.id, -32602, 'UNKNOWN_TOOL');
    try { validate(name, msg.params?.arguments ?? {}); }
    catch { return response(msg.id, { isError: true, content: [{ type: 'text', text: 'INVALID_ARGUMENTS' }] }); }
    return response(msg.id, { isError: true, content: [{ type: 'text', text: 'CODEX_DISABLED: isolated local execution policy required' }] });
  }
  if (msg.method === 'shutdown') return response(msg.id, null);
  return error(msg.id, -32601, 'METHOD_NOT_FOUND');
}

let pending = Promise.resolve();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on('line', line => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > 1024 * 1024) { error(null, -32600, 'MESSAGE_TOO_LARGE'); return; }
  pending = pending.then(async () => {
    let msg;
    try { msg = JSON.parse(line); }
    catch { error(null, -32700, 'PARSE_ERROR'); return; }
    try { await handle(msg); }
    catch { if (msg?.id !== undefined) error(msg.id, -32603, 'INTERNAL_ERROR'); }
  });
});

