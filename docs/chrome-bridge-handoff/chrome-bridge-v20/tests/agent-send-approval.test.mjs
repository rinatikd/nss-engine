import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8');

test('agent_send requires local approval and revalidates before injection', () => {
  const start = source.indexOf("if (['agent_send', 'agent_peek', 'agent_selftest'].includes(name))");
  const end = source.indexOf("\n  throw Error('Unknown command: ' + name);", start);
  assert.ok(start >= 0 && end > start, 'agent dispatch block exists');
  const block = source.slice(start, end);
  const approval = block.indexOf('await askApproval(');
  const inject = block.indexOf('await inject(');
  assert.ok(approval >= 0 && inject > approval, 'approval precedes injection');
  for (const check of [
    "if (!running) throw Error('Bridge stopped before send')",
    "if (Date.now() > expires) throw Error('Command expired')",
    'grants.require(site.origin)',
    'await chrome.tabs.get(args.tabId)',
    'await agentTab(args.tabId)',
    'verified.site.origin !== site.origin',
    'verified.adapterName !== adapterName',
    'findSecret(args.text)'
  ]) assert.ok(block.includes(check), `missing send guard: ${check}`);
});
