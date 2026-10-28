import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frame, decoder, syntheticRequest } from '../native/windows-runner-v06/ipc.mjs';

test('IPC split headers, split UTF8 and coalesced frames', () => {
  const got = [], d = decoder(v => got.push(v));
  const bytes = Buffer.concat([frame({ text: '\u0442\u0435\u0441\u0442\u{1f9ea}' }), frame({ ok: true })]);
  for (const byte of bytes) d.push(Buffer.from([byte]));
  d.end(); const coalesced = []; const bulk = decoder(v => coalesced.push(v)); bulk.push(bytes); bulk.end(); assert.deepEqual(coalesced, got); assert.deepEqual(got, [{ text: '\u0442\u0435\u0441\u0442\u{1f9ea}' }, { ok: true }]);
});
test('IPC rejects oversized, empty, truncated, malformed and invalid UTF8 frames', () => {
  for (const bytes of [Buffer.from([0,0,0,0]), Buffer.from([0,0,16,1]), Buffer.from([0,0,0,2,123]), Buffer.from([0,0,0,1,123]), Buffer.from([0,0,0,1,255])]) {
    const d = decoder(() => {}); assert.throws(() => { d.push(bytes); d.end(); });
  }
});
test('synthetic IPC ordinary process literal request response', async () => {
  const text = 'synthetic $(echo) & --flag "\u{1f9ea}"';
  assert.deepEqual(await syntheticRequest({ text }), { status: 'succeeded', text });
});
test('synthetic IPC cancellation, pre-abort and timeout confirm process close', async () => {
  const controller = new AbortController();
  const pending = syntheticRequest({ op: 'hold', signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await pending).status, 'cancelled');
  assert.equal((await syntheticRequest({ signal: controller.signal })).status, 'cancelled');
  assert.equal((await syntheticRequest({ op: 'hold', timeoutMs: 100 })).status, 'timed_out');
});
for (const op of ['bad','wrong-id','oversized','truncated','flood','stderr','crash']) test(`synthetic IPC rejects ${op}`, async () => {
  const r = await syntheticRequest({ op }); assert.equal(r.status, 'failed'); assert.equal(r.text, undefined);
});
test('IPC rejects executable, operation and input limit abuse before spawn', () => {
  for (const args of [{signal:{}}, {executable:'cmd.exe'}, {op:'codex_submit'}, {op:'cmd.exe'}, {text:'x'.repeat(1025)}, {timeoutMs:0}]) assert.throws(() => syntheticRequest(args), /INVALID_REQUEST/);
});


test('worker consumes cancellation frame and refuses duplicate or malformed requests', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { randomUUID } = await import('node:crypto');
  const fixture = fileURLToPath(new URL('../native/windows-runner-v06/ipc-fixture.mjs', import.meta.url));
  for (const scenario of ['cancel', 'duplicate', 'wrong-cancel', 'extra-field', 'wrong-version']) {
    const id = randomUUID(), child = spawn(process.execPath, [fixture], { env: {}, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('fixture deadline')); }, 2000);
      child.once('close', code => { clearTimeout(timer); resolve(code); });
      child.once('error', reject);
    });
    const run = { v: 1, type: 'run', id, op: 'hold', text: '' };
    const messages = scenario === 'cancel' ? [run, {v:1,type:'cancel',id}] :
      scenario === 'duplicate' ? [run, run] :
      scenario === 'wrong-cancel' ? [run, {v:1,type:'cancel',id:randomUUID()}] :
      scenario === 'extra-field' ? [{...run,executable:'cmd.exe'}] : [{...run,v:2}];
    child.stdin.on('error', () => {});
    child.stdin.write(Buffer.concat(messages.map(frame)));
    assert.equal(await exit, scenario === 'cancel' ? 0 : 8, scenario);
  }
});
