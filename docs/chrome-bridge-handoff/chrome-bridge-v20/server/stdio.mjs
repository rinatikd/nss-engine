// stdio-РїСЂРѕРєСЃРё РґР»СЏ Р»РѕРєР°Р»СЊРЅС‹С… MCP-С…РѕСЃС‚РѕРІ (Codex CLI, Claude Code): СЃС‚СЂРѕРєРё JSON-RPC -> HTTP-РјРѕСЃС‚.
import readline from 'node:readline';
import { loadConfig, PORT } from './bridge.mjs';

const config = loadConfig();
const input = readline.createInterface({ input: process.stdin });
let inflight = 0;
let closed = false;
const maybeExit = () => { if (closed && inflight === 0) process.exit(0); };
input.on('close', () => { closed = true; maybeExit(); });

input.on('line', async (line) => {
  if (!line.trim()) return;
  inflight++;
  let msg;
  try {
    msg = JSON.parse(line);
    const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.agentToken },
      body: JSON.stringify(msg),
    });
    if (r.status === 202) return;
    const body = await r.text();
    if (!r.ok) throw Error('Bridge HTTP ' + r.status);
    process.stdout.write(body + '\n');
  } catch (e) {
    if (msg?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message + '; run Start-Bridge.ps1' } }) + '\n');
    else console.error(e.message);
  } finally { inflight--; maybeExit(); }
});

