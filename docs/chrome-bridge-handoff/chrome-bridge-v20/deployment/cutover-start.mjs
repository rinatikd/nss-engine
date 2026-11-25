// Cutover entrypoint: never creates config/credentials or evaluates CLI policy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
try {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  if (process.env.CHROME_BRIDGE_CODEX_POLICY) throw Error('Execution policy forbidden');
  const bytes = fs.readFileSync(path.join(job.state, 'config.json'));
  if (crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase() !== job.configHash) throw Error('Config changed');
  const config = JSON.parse(bytes);
  if (typeof config.agentToken !== 'string' || typeof config.browserToken !== 'string') throw Error('Invalid config');
  const { createBridge } = await import(pathToFileURL(path.join(job.source, 'server/bridge.mjs')));
  const server = createBridge(config, { stateDir: job.state, codexJobs: null });
  server.once('error', () => { console.error('CUTOVER_START_FAILED'); process.exit(1); });
  server.listen(job.port, '127.0.0.1');
} catch { console.error('CUTOVER_START_FAILED'); process.exitCode = 1; }

