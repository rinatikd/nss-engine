// Child-process worker for concurrency / crash tests.  node worker.mjs <mode> <db> <log> <owner> [taskId]
import { Ledger } from '../../src/ledger.mjs';
import { runOnce } from '../../src/dispatcher.mjs';
import { MockAdapter } from '../../src/adapters/mock.mjs';
const [mode, db, log, owner, taskId] = process.argv.slice(2);
const ledger = new Ledger(db, { maxAttempts: 5 });
const ok = (task, n) => ({ text: `done ${task.id}` });
const crashing = (when) => new MockAdapter({ name: 'claude', logFile: log, behave: () => (when === 'send' ? 'crash' : ok()) });
if (mode === 'claim') { console.log(JSON.stringify(ledger.claim(taskId, owner, 60000))); process.exit(0); }
if (mode === 'drain') {
  const adapter = new MockAdapter({ name: 'claude', logFile: log, behave: ok });
  let idle = 0;
  while (idle < 3) { const r = await runOnce({ ledger, adapter, owner, ttlMs: 60000 }); if (r.status === 'idle') { idle++; await new Promise((x) => setTimeout(x, 30)); } else idle = 0; }
  process.exit(0);
}
// crash modes: do the steps up to the named point, then die without cleanup
const id = ledger.next('claude'); const c = ledger.claim(id, owner, 300);
if (mode === 'crash-after-claim') process.kill(process.pid, 'SIGKILL');
ledger.beginDispatch(id, owner, c.fence);
if (mode === 'crash-after-begin') process.kill(process.pid, 'SIGKILL');
await crashing('send').send(ledger.get(id)); // logs the send, then SIGKILLs itself
