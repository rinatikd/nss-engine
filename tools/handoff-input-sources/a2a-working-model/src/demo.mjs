import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, LedgerOperator } from './ledger.mjs';
import { drain } from './dispatcher.mjs';
import { MockAdapter } from './adapters/mock.mjs';

// ChatGPT (sender) -> ledger -> dispatcher -> Claude adapter (mock) -> artifact -> verification -> corrective task -> ChatGPT reads result.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-demo-'));
const file = path.join(dir, 'ledger.db');
const ledger = new Ledger(file);
const claude = new MockAdapter({ name: 'claude', behave: (task, n) => n === 1
  ? { text: 'looks fine' }                                  // no structured RESULT line: fails verification
  : { text: 'RESULT: 3 findings\nTESTS: 12 pass' } });
const verify = (_t, a) => /^RESULT:/m.test(a.text) ? { ok: true } : { ok: false, problems: ['MISSING_RESULT_LINE'] };

ledger.submit({ id: 'job-0001', contextId: 'proj-nss', sender: 'chatgpt', recipient: 'claude', text: 'Review PR #53 and report findings.' });
await drain({ ledger, adapter: claude, owner: 'dispatcher-1', verify });
for (const id of ['job-0001', 'job-0001-fix1']) {
  const t = ledger.get(id);
  console.log(`${id}: ${t.state} (attempts=${t.attempts})`);
  for (const e of ledger.events(id)) console.log('   ', e.kind, JSON.stringify(e.body).slice(0, 110));
}
ledger.close(); fs.rmSync(dir, { recursive: true, force: true });
