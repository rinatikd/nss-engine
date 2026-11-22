// Cutover entrypoint: never creates config/credentials or evaluates CLI policy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
let redactions = [];
try {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  if (process.env.CHROME_BRIDGE_CODEX_POLICY) throw Error('Execution policy forbidden');
  const bytes = fs.readFileSync(path.join(job.state, 'config.json'));
  if (crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase() !== job.configHash) throw Error('Config changed');
  const config = JSON.parse(bytes);
  redactions = [config.agentToken, config.browserToken].filter(value => typeof value === 'string' && value.length > 0);
  if (typeof config.agentToken !== 'string' || typeof config.browserToken !== 'string') throw Error('Invalid config');
  const { createBridge } = await import(pathToFileURL(path.join(job.source, 'server/bridge.mjs')));
  const server = createBridge(config, { stateDir: job.state, codexJobs: null });
  server.once('error', (error) => {
    let detail = String(error?.stack || error?.message || error || 'unknown server error').slice(0, 6000);
    for (const secret of redactions) detail = detail.split(secret).join('[REDACTED]');
    console.error('CUTOVER_START_FAILED:', detail);
    process.exitCode = 1;
  });
  server.listen(job.port, '127.0.0.1');
} catch (error) {
  let detail = String(error?.stack || error?.message || error || 'unknown startup error').slice(0, 6000);
  for (const secret of redactions) detail = detail.split(secret).join('[REDACTED]');
  console.error('CUTOVER_START_FAILED:', detail);
  process.exitCode = 1;
}

