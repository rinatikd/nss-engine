// Newline-delimited MCP stdio -> authenticated loopback HTTP bridge.
import readline from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, PORT } from './bridge.mjs';
import { validateRpcEnvelope } from './rpc-envelope.mjs';

export function runStdio({ input = process.stdin, output = process.stdout, diagnostics = process.stderr, config = loadConfig(), port = PORT, timeoutMs = 120000 } = {}) {
  const lines = readline.createInterface({ input });
  let inflight = 0;
  let closed = false;
  // A failing write's callback can precede asynchronous stream destruction.
  // Retain the handler through that error/close event, then release both listeners.
  const initiallyDestroyed = output.destroyed;
  let outputFailed = false, outputTerminated = false, completed = false;
  const cleanupOutput = () => {
    output.off('error', onOutputError);
    output.off('close', onOutputError);
  };
  const onOutputError = () => { outputTerminated = true; if (completed) cleanupOutput(); };
  output.on('error', onOutputError);
  output.on('close', onOutputError);
  const write = value => new Promise((resolve, reject) => {
    output.write(JSON.stringify(value) + '\n', error => {
      if (error) { outputFailed = true; reject(error); }
      else resolve();
    });
  });
  const rpcError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  return new Promise(resolve => {
    // Wait for write callbacks as well as HTTP replies. Forced process.exit truncates
    // large responses when the host closes stdin immediately after its last request.
    const maybeDone = () => { if (closed && inflight === 0) resolve(); };
    lines.on('close', () => { closed = true; maybeDone(); });
    lines.on('line', line => {
      if (!line.trim()) return;
      inflight++;
      (async () => {
        let msg;
        try { msg = JSON.parse(line); }
        catch { await rpcError(null, -32700, 'Parse error'); return; }
        const validation = validateRpcEnvelope(msg);
        if (!validation.ok) {
          await write(validation.response);
          return;
        }
        const { notification } = validation;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.agentToken },
            body: JSON.stringify(msg),
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
          });
          const body = await response.text();
          if (!response.ok) throw Error('Bridge HTTP ' + response.status);
          if (notification) return;
          const reply = JSON.parse(body);
          if (!reply || reply.jsonrpc !== '2.0' || reply.id !== msg.id ||
              Object.hasOwn(reply, 'result') === Object.hasOwn(reply, 'error')) throw Error('Invalid bridge response');
          if (Object.hasOwn(reply, 'error') && (!reply.error || typeof reply.error !== 'object' ||
              Array.isArray(reply.error) || !Number.isInteger(reply.error.code) ||
              typeof reply.error.message !== 'string')) throw Error('Invalid bridge error');
          // Re-serialize so upstream whitespace cannot break stdio line framing.
          await write(reply);
        } catch {
          if (!notification) await rpcError(msg.id, -32603, 'Bridge transport or protocol error; check Start-Bridge.ps1. The operation may have completed; do not retry side effects automatically.');
          else diagnostics.write('Bridge notification transport failed.\n');
        }
      })().catch(() => { diagnostics.write('Bridge stdio output failed.\n'); }).finally(() => { inflight--; maybeDone(); });
    });
  }).finally(() => {
    completed = true;
    if (!outputFailed || outputTerminated || initiallyDestroyed) cleanupOutput();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runStdio();
