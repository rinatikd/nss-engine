import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const script = readFileSync(new URL('../deployment/diagnose-mcp-link.ps1', import.meta.url), 'utf8');

test('MCP route probe cannot modify services or disclose auth material', () => {
  assert.match(script, /Get-NetTCPConnection/);
  assert.match(script, /Get-Process/);
  assert.match(script, /Method = 'GET'/);
  assert.match(script, /\$req\.Proxy = \$null/);
  assert.doesNotMatch(script, /\.Method\s*=\s*'POST'/);
  assert.doesNotMatch(script, /Authorization\s*=/);
  assert.doesNotMatch(script, /Get-Content\s+.*config\.json|ReadAllText|Get-ChildItem\s+Env:|\.CommandLine/);
  assert.doesNotMatch(script, /Stop-Process|Start-Process|Set-Content|Set-Item|Register-ScheduledTask|Restart-Service/);
});

test('Windows PowerShell 5.1 read-only probe exits cleanly for unavailable test port', { skip: platform() !== 'win32' }, () => {
  const ps1 = new URL('../deployment/diagnose-mcp-link.ps1', import.meta.url);
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', decodeURIComponent(ps1.pathname).replace(/^\//, ''),
    '-Ports', '65429', '-TimeoutMs', '600', '-SkipHttp'
  ], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CHROME_BRIDGE_MCP_LINK_DIAGNOSTICS/);
  assert.match(result.stdout, /\[TCP\] port=65429 reachable=/);
  assert.match(result.stdout, /\[DONE\] No configuration changed/);
});
