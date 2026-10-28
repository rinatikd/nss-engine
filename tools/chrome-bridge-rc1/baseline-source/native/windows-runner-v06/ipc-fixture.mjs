import { decoder, frame } from './ipc.mjs';
let active = null;
const read = decoder(m => {
  if (m?.v !== 1 || typeof m.id !== 'string' || !/^[0-9a-f-]{36}$/.test(m.id)) throw Error('INVALID');
  if (m.type === 'cancel' && m.id === active && Object.keys(m).sort().join(',') === 'id,type,v') process.exit(0);
  if (active || m.type !== 'run' || Object.keys(m).sort().join(',') !== 'id,op,text,type,v' || typeof m.text !== 'string' || Buffer.byteLength(m.text) > 1024) throw Error('INVALID');
  active = m.id;
  const send = (type, seq, extra = {}) => process.stdout.write(frame({ v: 1, type, id: active, seq, ...extra }));
  if (m.op === 'hold') return;
  if (m.op === 'crash') process.exit(7);
  if (m.op === 'bad') return process.stdout.write(Buffer.from([0, 0, 0, 1, 123]));
  if (m.op === 'wrong-id') { active = 'wrong'; return send('done', 0); }
  if (m.op === 'oversized') return process.stdout.write(Buffer.from([0, 1, 0, 0]));
  if (m.op === 'truncated') { process.stdout.write(Buffer.from([0, 0, 0, 10, 123])); return process.exit(0); }
  if (m.op === 'stderr') return process.stderr.write('s'.repeat(2048));
  if (m.op === 'flood') { for (let i = 0; i < 10; i++) send('output', i, { text: 'x'.repeat(1024) }); return; }
  if (m.op !== 'echo') throw Error('INVALID');
  send('output', 0, { text: m.text }); send('done', 1);
});
process.stdin.on('data', c => { try { read.push(c); } catch { process.exit(8); } });
process.stdin.on('end', () => process.exit(0));
