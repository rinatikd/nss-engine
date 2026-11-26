// Read-only deployment check. Never prints credentials or calls tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkDiscovery(url, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.result?.tools)) throw Error('Invalid tools/list response');
  const names = body.result.tools.map(tool => tool.name);
  const missing = ['codex_submit', 'codex_job', 'codex_cancel'].filter(name => !names.includes(name));
  return { count: names.length, names, missing, ok: missing.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const port = Number(process.argv[2] || 17381);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
    // Only loopback endpoints; credentials cannot be redirected to an arbitrary host.
    const configPath = path.join(process.env.CHROME_BRIDGE_HOME || path.join(os.homedir(), '.chrome-bridge'), 'config.json');
    const { agentToken } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const result = await checkDiscovery(`http://127.0.0.1:${port}/mcp`, agentToken);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.error('Discovery check failed (configuration, transport or protocol error).');
    process.exitCode = 2;
  }
}

