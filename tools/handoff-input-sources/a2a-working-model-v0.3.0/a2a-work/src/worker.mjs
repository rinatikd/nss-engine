import { Ledger } from './ledger.mjs';
import { runOnce } from './dispatcher.mjs';
import { HttpAgentAdapter } from './adapters/http-agent.mjs';

const dbPath = process.env.A2A_DB;
const adapterUrl = process.env.A2A_ADAPTER_URL;
const recipient = process.env.A2A_RECIPIENT ?? 'claude';
const owner = process.env.A2A_WORKER_ID ?? `worker-${process.pid}`;
const token = process.env.A2A_ADAPTER_TOKEN ?? '';
const timeoutMs = Number(process.env.A2A_ADAPTER_TIMEOUT_MS ?? 120000);
const pollMs = Number(process.env.A2A_POLL_MS ?? 500);
if (!dbPath || !adapterUrl) {
  console.error('Set A2A_DB (absolute path) and A2A_ADAPTER_URL (HTTPS except loopback) to run the real adapter worker.');
  process.exit(2);
}
const ledger = new Ledger(dbPath);
const adapter = new HttpAgentAdapter({ name: recipient, url: adapterUrl, token, timeoutMs });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
console.log(`A2A worker ${owner} serving recipient=${recipient}; adapter=${new URL(adapterUrl).origin}`);
try {
  while (!stopping) {
    const result = await runOnce({ ledger, adapter, owner, ttlMs: Math.max(timeoutMs + 30000, 60000) });
    if (result.status !== 'idle') console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    if (result.status === 'idle') await new Promise(resolve => setTimeout(resolve, pollMs));
  }
} finally { ledger.close(); }
