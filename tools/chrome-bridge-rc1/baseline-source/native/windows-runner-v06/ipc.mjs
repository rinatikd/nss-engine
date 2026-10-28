import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Experimental synthetic transport. Never imported by Hub, bridge, or Codex loader.
export const MAX_FRAME = 4096;
export function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > MAX_FRAME) throw Error('FRAME_LIMIT');
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export function decoder(accept) {
  let pending = Buffer.alloc(0), needed = null;
  return {
    push(chunk) {
      // Incremental copying keeps retained memory bounded even for hostile chunks.
      let offset = 0;
      while (offset < chunk.length) {
        const target = needed === null ? 4 : needed;
        const take = Math.min(target - pending.length, chunk.length - offset);
        pending = Buffer.concat([pending, chunk.subarray(offset, offset + take)]); offset += take;
        if (pending.length !== target) continue;
        if (needed === null) {
          needed = pending.readUInt32BE(); pending = Buffer.alloc(0);
          if (!needed || needed > MAX_FRAME) throw Error('FRAME_LIMIT');
        } else {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending));
          needed = null; pending = Buffer.alloc(0); accept(value);
        }
      }
    },
    end() { if (needed !== null || pending.length) throw Error('TRUNCATED_FRAME'); },
  };
}
const fixture = fileURLToPath(new URL('./ipc-fixture.mjs', import.meta.url));
export function syntheticRequest(args = {}) {
  if (!args || typeof args !== 'object' || Object.keys(args).some(k => !['op','text','timeoutMs','signal'].includes(k))) throw Error('INVALID_REQUEST');
  const { op = 'echo', text = '', timeoutMs = 1000, signal } = args;
  if (!['echo', 'hold', 'flood', 'bad', 'crash', 'wrong-id', 'oversized', 'truncated', 'stderr'].includes(op) ||
      typeof text !== 'string' || Buffer.byteLength(text) > 1024 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5000) throw Error('INVALID_REQUEST');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw Error('INVALID_REQUEST');
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    // Fixed executable, fixed fixture, empty environment, no shell or arbitrary paths/argv.
    const child = spawn(process.execPath, [fixture], { env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let terminal = null, output = '', total = 0, seq = 0, stderr = 0, watchdog;
    const finish = (status, error) => {
      if (terminal) return;
      terminal = { status, ...(error ? { error } : {}), ...(status === 'succeeded' ? { text: output } : {}) };
      clearTimeout(deadline);
      child.kill();
      watchdog = setTimeout(() => { cleanup(); reject(Error('TERMINATION_UNCONFIRMED')); }, 2000);
    };
    const cancel = () => {
      if (!terminal && child.stdin.writable) child.stdin.write(frame({ v: 1, type: 'cancel', id }));
      finish('cancelled');
    };
    const cleanup = () => { clearTimeout(deadline); clearTimeout(watchdog); signal?.removeEventListener('abort', cancel); };
    const read = decoder(m => {
      if (terminal) return;
      if (seq >= 128) throw Error('MESSAGE_LIMIT');
      if (!m || m.v !== 1 || m.id !== id || m.seq !== seq++ || !['output', 'done'].includes(m.type)) throw Error('INVALID_RESPONSE');
      const keys = Object.keys(m).sort().join(',');
      if (m.type === 'output') {
        if (keys !== 'id,seq,text,type,v' || typeof m.text !== 'string') throw Error('INVALID_RESPONSE');
        total += Buffer.byteLength(m.text);
        if (total > 8192) throw Error('OUTPUT_LIMIT');
        output += m.text;
      } else {
        if (keys !== 'id,seq,type,v') throw Error('INVALID_RESPONSE');
        finish('succeeded');
      }
    });
    const deadline = setTimeout(() => finish('timed_out'), timeoutMs);
    child.stdout.on('data', c => { try { read.push(c); } catch { finish('failed', 'PROTOCOL_OR_OUTPUT_LIMIT'); } });
    child.stderr.on('data', c => { stderr += c.length; if (stderr > 1024) finish('failed', 'STDERR_LIMIT'); });
    child.stdin.on('error', () => finish('failed', 'TRANSPORT_FAILED'));
    child.on('error', () => finish('failed', 'TRANSPORT_FAILED'));
    child.on('close', () => {
      if (!terminal) { try { read.end(); } catch {} terminal = { status: 'failed', error: 'INCOMPLETE_RESPONSE' }; }
      cleanup(); resolve(terminal);
    });
    child.stdin.write(frame({ v: 1, type: 'run', id, op, text }));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
