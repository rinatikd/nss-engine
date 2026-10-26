import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '../src/server.mjs');

async function withServer(fn) {
  const child = spawn(process.execPath, [server], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_DISABLED: '1' },
    windowsHide: true,
  });
  let buffer = '';
  let stderr = '';
  let pending = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const i = buffer.indexOf('\n');
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        for (const p of pending.values()) p.reject(e);
        pending.clear();
        continue;
      }
      if (pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  });
  child.on('error', error => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  });
  const rpc = (id, method, params) => new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('MCP response timed out; stderr: ' + stderr.slice(0, 400)));
    }, 5000);
    pending.set(id, {
      resolve: r => { clearTimeout(timeout); resolveResponse(r); },
      reject: e => { clearTimeout(timeout); reject(e); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try { await fn(rpc, child); } finally {
    child.stdin.end();
    child.kill();
    for (const p of pending.values()) p.reject(new Error('Server closed'));
    pending.clear();
  }
}

test('direct v21 stdio MCP stays transport-only and fails closed', async () => {
  await withServer(async rpc => {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'rc32-test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'direct-local-codex-mcp');
    const list = await rpc(2, 'tools/list', {});
    assert.deepEqual(list.result.tools.map(x => x.name).sort(), ['codex_cancel', 'codex_job', 'codex_submit']);
    const denied = await rpc(3, 'tools/call', { name: 'codex_submit', arguments: { requestId: 'rc32_test_only', workspace: 'nss-engine', prompt: 'no action' } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /CODEX_DISABLED/);
    assert.equal(JSON.stringify(denied).includes('jobId'), false);
    const malformed = await rpc(4, 'tools/call', { name: 'codex_submit', arguments: { requestId: 'a', workspace: 'b', prompt: 'c', unexpected: 'x' } });
    assert.match(malformed.result.content[0].text, /INVALID_ARGUMENTS/);
    const unknown = await rpc(5, 'tools/call', { name: 'codex_launch', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const ping = await rpc(6, 'ping', {});
    assert.deepEqual(ping.result, {});
    const shutdown = await rpc(7, 'shutdown', {});
    assert.equal(shutdown.result, null);
  });
});
