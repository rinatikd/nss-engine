import path from 'node:path';
import { Ledger } from './ledger.mjs';
import { runOnce } from './dispatcher.mjs';
import { HttpAgentAdapter } from './adapters/http-agent.mjs';
import { CodexCliAdapter } from './adapters/codex-cli.mjs';

const dbPath = process.env.A2A_DB;
const adapterKind = (process.env.A2A_ADAPTER ?? 'http').toLowerCase();
const recipient = process.env.A2A_RECIPIENT ?? (adapterKind === 'codex-cli' ? 'codex' : 'claude');
const owner = process.env.A2A_WORKER_ID ?? `worker-${process.pid}`;
const timeoutMs = Number(process.env.A2A_ADAPTER_TIMEOUT_MS ?? (adapterKind === 'codex-cli' ? 600000 : 120000));
const pollMs = Number(process.env.A2A_POLL_MS ?? 500);
if (!dbPath || !path.isAbsolute(dbPath)) {
  console.error('Set A2A_DB to the same absolute path used by the A2A server.'); process.exit(2);
}
let adapter;
if (adapterKind === 'codex-cli') {
  const cwd = process.env.A2A_CODEX_CWD;
  if (!cwd || !path.isAbsolute(cwd)) { console.error('Set A2A_CODEX_CWD to an absolute workspace path.'); process.exit(2); }
  adapter = new CodexCliAdapter({ name: recipient, executable: process.env.A2A_CODEX_EXECUTABLE ?? 'codex', cwd,
    model: process.env.A2A_CODEX_MODEL, timeoutMs, sandbox: process.env.A2A_CODEX_SANDBOX ?? 'read-only',
    approval: process.env.A2A_CODEX_APPROVAL ?? 'never', provider: process.env.A2A_CODEX_PROVIDER ?? 'configured',
    localPort: Number(process.env.A2A_CODEX_LOCAL_PORT ?? 11434) });
} else if (adapterKind === 'http') {
  const adapterUrl = process.env.A2A_ADAPTER_URL;
  if (!adapterUrl) { console.error('Set A2A_ADAPTER_URL for HTTP adapter.'); process.exit(2); }
  adapter = new HttpAgentAdapter({ name: recipient, url: adapterUrl, token: process.env.A2A_ADAPTER_TOKEN ?? '', timeoutMs });
} else { console.error('A2A_ADAPTER must be http or codex-cli.'); process.exit(2); }
const ledger = new Ledger(dbPath);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
console.log(`A2A worker ${owner} serving recipient=${recipient}; adapter=${adapterKind}`);
try {
  while (!stopping) {
    const result = await runOnce({ ledger, adapter, owner, ttlMs: Math.max(timeoutMs + 30000, 60000) });
    if (result.status !== 'idle') console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    if (result.status === 'idle') await new Promise(resolve => setTimeout(resolve, pollMs));
  }
} finally { ledger.close(); }
