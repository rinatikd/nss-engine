// Local setup and read-only diagnostics. Never emit configuration values or tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/bridge.mjs';

class LocalError extends Error {}

const args = process.argv.slice(2);
const command = args.shift();
const stateDir = path.resolve(process.env.CHROME_BRIDGE_HOME || path.join(os.homedir(), '.chrome-bridge'));
const file = path.join(stateDir, 'config.json');
const extensionPattern = /^[a-p]{32}$/;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new LocalError('Node.js 22 or newer is required.');
  if (!['setup', 'doctor'].includes(command)) throw new LocalError('Use setup or doctor.');
  const idIndex = args.indexOf('--extension-id');
  const extensionId = idIndex >= 0 ? args[idIndex + 1] : undefined;
  const allowed = command === 'setup' ? (idIndex === 0 && args.length === 2) || args.length === 0 : args.length === 0 || (args.length === 1 && args[0] === '--live');
  if (!allowed || (idIndex >= 0 && !extensionPattern.test(extensionId || ''))) throw new LocalError('Invalid options. Extension ID must contain 32 letters a-p.');
  const port = Number(process.env.CHROME_BRIDGE_PORT || 17381);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LocalError('CHROME_BRIDGE_PORT must be an integer from 1 to 65535.');
  if (command === 'setup') {
    const config = loadConfig(stateDir);
    if (extensionId) {
      config.extensionId = extensionId;
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    }
    console.log('Local configuration ready. Existing tokens preserved. No MCP registration changed.');
    if (!extensionPattern.test(config.extensionId || '')) {
      console.log('Load the extension folder in chrome://extensions, copy its ID, then rerun Setup-Windows.ps1 -ExtensionId <ID>.');
      return;
    }
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new LocalError('Configuration missing or unreadable. Run Setup-Windows.ps1.'); }
  if (![config.agentToken, config.browserToken].every(token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token))) throw new LocalError('Configuration has invalid tokens. Restore a known good private config; do not share it.');
  if (!extensionPattern.test(config.extensionId || '')) throw new LocalError('Extension ID is not pinned. Run Setup-Windows.ps1 -ExtensionId <ID>.');
  if (process.env.CHROME_BRIDGE_EXTENSION_ID && process.env.CHROME_BRIDGE_EXTENSION_ID !== config.extensionId) throw new LocalError('CHROME_BRIDGE_EXTENSION_ID conflicts with the configured extension ID.');
  for (const name of ['server/bridge.mjs', 'server/stdio.mjs', 'extension/manifest.json']) {
    if (!fs.existsSync(path.join(root, name))) throw new LocalError('Required release files are missing. Extract the complete release.');
  }
  console.log('PASS: Node version, release files, local configuration, extension pin and port.');
  if (command === 'doctor' && args.includes('--live')) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'doctor', method: 'tools/call', params: { name: 'browser_status', arguments: {} } }),
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
    } catch { throw new LocalError('Local bridge is unreachable. Start Start-Bridge.ps1 in another window.'); }
    if (!response.ok) throw new LocalError('Local bridge rejected the diagnostic request. Check port and private configuration.');
    let rpc;
    try { rpc = await response.json(); } catch { throw new LocalError('Local endpoint did not return valid MCP JSON.'); }
    if (rpc.id !== 'doctor' || rpc.error || rpc.result?.isError) throw new LocalError('Local MCP diagnostic failed.');
    const content = rpc.result?.content?.find(item => item.type === 'text')?.text;
    let status;
    try { status = JSON.parse(content); } catch { throw new LocalError('Local MCP diagnostic returned an unexpected status.'); }
    if (status.connected !== true) throw new LocalError('Bridge is running, but Chrome is disconnected. Open the extension control window and press Connect.');
    console.log('PASS: authenticated local MCP and Chrome connection. Live websites and agent registration were not tested.');
  }
}
main().catch(error => {
  console.error(error instanceof LocalError ? error.message : 'Local setup failed. Check private configuration and filesystem permissions; never share config.json.');
  process.exitCode = 1;
});
