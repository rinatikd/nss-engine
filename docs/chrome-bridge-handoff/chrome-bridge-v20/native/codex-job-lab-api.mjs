// Explicitly opt-in, loopback-only API for INTERNAL selftest jobs.
// No Codex execution, browser control, production bridge, or tunnel integration.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOST = '127.0.0.1';
const PORT = 17484; // dedicated lab port; never production 17381/17382 or RC1 17481
const script = join(dirname(fileURLToPath(import.meta.url)), 'Invoke-CodexJobDispatcherLab.ps1');
const token = randomBytes(32).toString('hex');
const MAX_RESPONSE = 32 * 1024;
let busy = false;

function authorized(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function respond(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function invoke(command, jobId) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      command === 'job_start' ? '-Start' : command === 'job_status' ? '-Status' : '-Cancel'];
    if (jobId) args.push('-JobId', jobId);
    const child = spawn('powershell.exe', args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '', error = '', length = 0, done = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('LAB_COMMAND_TIMEOUT')); }, 45000);
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
      stream.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_RESPONSE) { child.kill(); return; }
        if (isError) error += chunk.toString('utf8');
        else output += chunk.toString('utf8');
      });
    }
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (length > MAX_RESPONSE) return reject(new Error('LAB_OUTPUT_LIMIT'));
      if (code !== 0) return reject(new Error('LAB_COMMAND_FAILED: ' + error.slice(0, 500)));
      resolve({ output: output.trim(), jobId: output.match(/CODEX_JOB_ID:\s*([a-f0-9]{32})/)?.[1] ?? jobId ?? null,
        status: output.match(/CODEX_JOB_STATUS:\s*([A-Z_]+)/)?.[1] ?? null });
    });
  });
}
const server = http.createServer(async (req, res) => {
  if (req.socket.remoteAddress !== HOST && req.socket.remoteAddress !== '::ffff:127.0.0.1') return respond(res, 403, { error: 'LOOPBACK_ONLY' });
  if (!authorized(req)) return respond(res, 401, { error: 'UNAUTHORIZED' });
  if (req.method !== 'POST' || req.url !== '/lab/jobs') return respond(res, 404, { error: 'NOT_FOUND' });
  if (busy) return respond(res, 429, { error: 'LAB_BUSY' });
  busy = true;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString('utf8');
      if (Buffer.byteLength(raw) > 4096) return respond(res, 413, { error: 'REQUEST_TOO_LARGE' });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return respond(res, 400, { error: 'INVALID_JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, { error: 'INVALID_REQUEST' });
    const { command, jobId } = body;
    if (!['job_start', 'job_status', 'job_cancel'].includes(command)) return respond(res, 400, { error: 'UNKNOWN_COMMAND' });
    if (command !== 'job_start' && (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId))) return respond(res, 400, { error: 'INVALID_JOB_ID' });
    if (command === 'job_start' && jobId !== undefined) return respond(res, 400, { error: 'UNEXPECTED_JOB_ID' });
    const result = await invoke(command, jobId);
    return respond(res, 200, { ok: true, command, ...result, mode: 'INTERNAL_SELFTEST_ONLY' });
  } catch (e) {
    return respond(res, 500, { ok: false, error: String(e.message).slice(0, 600) });
  } finally { busy = false; }
});
server.on('error', e => { console.error('LAB_API_START_FAILED:', e.message); process.exitCode = 1; });
server.listen(PORT, HOST, () => {
  console.log('LAB_API_READY: http://' + HOST + ':' + PORT);
  console.log('LAB_API_BEARER_TOKEN: ' + token);
  console.log('LAB_API_SCOPE: INTERNAL_SELFTEST_ONLY');
  console.log('LAB_API_PRODUCTION_CHANGED: NO');
});
