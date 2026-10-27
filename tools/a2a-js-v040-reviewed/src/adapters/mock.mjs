import fs from 'node:fs';
import { NotDispatched } from '../dispatcher.mjs';

/** Test double. `behave(task, n)` returns a response object, or one of 'not_dispatched' | 'ambiguous' | 'crash' | 'input'.
 *  Every send is appended to `logFile` at the moment of sending, so tests can count real dispatches across processes. */
export class MockAdapter {
  constructor({ name, behave, logFile = null }) { this.name = name; this.behave = behave; this.logFile = logFile; this.calls = 0; }
  async send(task) {
    const n = ++this.calls;
    const b = this.behave(task, n);
    if (b === 'not_dispatched') throw new NotDispatched();
    if (this.logFile) fs.appendFileSync(this.logFile, task.id + '\n');
    if (b === 'crash') process.kill(process.pid, 'SIGKILL');
    if (b === 'ambiguous') throw new Error('socket hang up');
    if (b === 'input') return { kind: 'input_required', question: 'Which branch?' };
    return { kind: 'response', text: b.text, invocationId: b.invocationId ?? `inv-${task.id}-${n}` };
  }
}
