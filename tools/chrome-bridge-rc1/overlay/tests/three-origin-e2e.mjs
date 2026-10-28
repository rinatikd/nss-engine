import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createBridge } from '../server/bridge.mjs';

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bridge-v19-three-origin-'));
const stateDir = path.join(runDir, 'state');
const extensionDir = path.join(runDir, 'extension');
const tokens = { agentToken: crypto.randomBytes(32).toString('hex'), browserToken: crypto.randomBytes(32).toString('hex') };
fs.cpSync(path.resolve('extension'), extensionDir, { recursive: true });
const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicDer = publicKey.export({ type: 'spki', format: 'der' });
manifest.key = publicDer.toString('base64');
tokens.extensionId = crypto.createHash('sha256').update(publicDer).digest().subarray(0, 16).toString('hex').replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const providers = [
  { name: 'claude', origin: 'https://claude.ai', conversationId: 'fixture-claude-1234', path: '/chat/fixture-claude-1234', composer: '<div class="ProseMirror" contenteditable="true"></div>', send: '<button aria-label="Send message">Send</button>', replyClass: 'font-claude-response' },
  { name: 'gemini', origin: 'https://gemini.google.com', conversationId: 'fixture-gemini-1234', path: '/app/fixture-gemini-1234', composer: '<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>', send: '<button class="send-button">Send</button>', replyClass: 'model-response-text' },
  { name: 'deepseek', origin: 'https://chat.deepseek.com', conversationId: 'fixture-deepseek-1234', path: '/a/chat/s/fixture-deepseek-1234', composer: '<textarea class="ds-scroll-area"></textarea>', send: '<div role="button" class="ds-button ds-button--primary ds-button--filled">Send</div>', replyClass: 'ds-markdown' },
];
let bridge;
let context;

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}
function close(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(resolve);
    server.closeAllConnections?.();
  });
}
function bridgeFor(state) {
  return createBridge(tokens, { stateDir, timeout: 6000, pollHold: 300, settleMs: 100, pollMs: 30, ...state });
}

try {
  bridge = bridgeFor({});
  await listen(bridge);
  const port = bridge.address().port;
  assert.notEqual(port, 17381);
  const base = `http://127.0.0.1:${port}`;
  const controlJs = path.join(extensionDir, 'control.js');
  fs.writeFileSync(controlJs, fs.readFileSync(controlJs, 'utf8').replace('http://127.0.0.1:17381', base));
  manifest.host_permissions = [base + '/*', ...providers.map((p) => p.origin + '/*')];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext(path.join(runDir, 'profile'), {
    channel: 'chromium', headless: false, viewport: { width: 1100, height: 800 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--window-position=-1200,-1200'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  assert.equal(extensionId, tokens.extensionId, 'runtime extension ID must equal the pinned manifest ID');
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/control.html`);
  await context.route('https://**/*', async (route) => {
    const url = new URL(route.request().url());
    const provider = providers.find((p) => p.origin === url.origin);
    if (!provider) return route.abort();
    const reply = `fixture-response-${provider.name}`;
    const script = `window.fixtureClicks=0;document.querySelector('button,[role=button]').addEventListener('click',()=>{window.fixtureClicks++;const user=document.createElement('div');user.dataset.fixtureUser='true';user.textContent='fixture-user-message';document.body.append(user);const box=document.querySelector('[contenteditable=true],textarea');if(box){if(box instanceof HTMLTextAreaElement)box.value='';else box.textContent='';}const answer=document.createElement('div');answer.className=${JSON.stringify(provider.replyClass)};answer.textContent=${JSON.stringify(reply)};document.body.append(answer);});`;
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><body>${provider.composer}${provider.send}<script>${script}</script></body>` });
  });

  const sites = Object.fromEntries(providers.map((p) => [p.origin, { mode: 'chat', adapter: p.name }]));
  await control.evaluate((value) => chrome.storage.local.set({ sites: value }), sites);
  await control.reload();
  const pages = new Map();
  for (const p of providers) {
    const page = await context.newPage();
    await page.goto(p.origin + p.path);
    pages.set(p.name, page);
    const contextEvidence = await page.evaluate(async () => {
      const routeMap = {
        'https://claude.ai': /^\/chat\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
        'https://gemini.google.com': /^\/app\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
        'https://chat.deepseek.com': /^\/a\/chat\/s\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
      };
      return { origin: location.origin, conversationId: location.pathname.match(routeMap[location.origin])?.[1] || null };
    });
    assert.equal(contextEvidence.origin, p.origin);
    assert.equal(contextEvidence.conversationId, p.conversationId);
  }

  control.on('dialog', (dialog) => dialog.accept());
  await control.fill('#token', tokens.browserToken);
  await control.click('#connect');
  const rpc = async (name, args = {}) => {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
    const payload = await response.json();
    if (payload.result?.isError) throw Error(payload.result.content?.[0]?.text || `${name} failed`);
    return JSON.parse(payload.result.content[0].text);
  };
  let connected = { connected: false };
  for (let attempt = 0; attempt < 30 && !connected.connected; attempt++) {
    connected = await rpc('browser_status');
    if (!connected.connected) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(connected.connected, true);

  for (const p of providers) {
    const row = control.locator('#sites li').filter({ hasText: p.origin });
    await row.getByText('Grant control', { exact: true }).click();
    const tab = (await rpc('browser_tabs')).find((t) => t.url === p.origin + p.path);
    assert.ok(tab, `missing ${p.name} fixture tab`);
    const binding = await rpc('agent_bind', { name: p.name, tabId: tab.tabId });
    assert.equal(binding.bound, p.name);
    const requestId = `v18-${p.name}-one-send`;
    const result = await rpc('agent_ask', { name: p.name, text: 'Reply with the short fixture acknowledgement only.', requestId, timeoutSec: 8 });
    if (result.done !== true) {
      // This fresh profile contains only locally fulfilled synthetic fixtures.
      // Keep failure evidence bounded and redact both generated bridge tokens.
      const observations = await Promise.allSettled([
        control.locator('#log').innerText({ timeout: 1500 }),
        pages.get(p.name).locator('body').evaluate(() => window.fixtureClicks, undefined, { timeout: 1500 }),
      ]);
      const sanitize = value => String(value).replaceAll(tokens.agentToken, '[REDACTED]').replaceAll(tokens.browserToken, '[REDACTED]');
      const resultJson = sanitize(JSON.stringify(result));
      const diagnostic = {
        provider: p.name,
        result: resultJson.length <= 8000 ? JSON.parse(resultJson) : { truncated: true, jsonPrefix: resultJson.slice(0, 8000) },
        controlLog: observations[0].status === 'fulfilled' ? sanitize(observations[0].value).slice(-6000) : 'UNAVAILABLE',
        fixtureClicks: observations[1].status === 'fulfilled' && Number.isSafeInteger(observations[1].value) ? observations[1].value : null,
      };
      console.error('SYNTHETIC_E2E_FAILURE ' + JSON.stringify(diagnostic));
    }
    assert.equal(result.done, true);
    assert.equal(result.reply, `fixture-response-${p.name}`);
    assert.equal(result.deliveryStatus, 'UNKNOWN');
    assert.equal(result.replyAttribution, 'UNVERIFIED');
    const duplicate = await rpc('agent_send', { name: p.name, text: 'Reply with the short fixture acknowledgement only.', requestId });
    assert.equal(duplicate.sent, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(await pages.get(p.name).evaluate(() => window.fixtureClicks), 1);
    console.log(`PASS synthetic Control/MCP lifecycle ${p.name}: one click, reply observed, delivery UNKNOWN, duplicate suppressed`);
  }

  const journal = JSON.parse(fs.readFileSync(path.join(stateDir, 'send-journal.json'), 'utf8'));
  assert.equal(journal.version, 2);
  assert.equal(Object.keys(journal.entries).length, 3);
  for (const p of providers) {
    const entry = journal.entries[`v18-${p.name}-one-send`];
    assert.equal(entry.origin, p.origin);
    assert.match(entry.conversationFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(entry).includes('fixture-user-message'));
  }

  await control.click('#stop');
  await close(bridge);
  bridge = bridgeFor({});
  await listen(bridge, port);
  await control.waitForTimeout(300);
  const deepseekRequestId = 'v18-deepseek-one-send';
  const afterRestart = await rpc('agent_send', { name: 'deepseek', text: 'Reply with the short fixture acknowledgement only.', requestId: deepseekRequestId });
  assert.equal(afterRestart.duplicate, true);
  assert.equal(await pages.get('deepseek').evaluate(() => window.fixtureClicks), 1);
  console.log('PASS bridge restart/replay: same requestId returned duplicate and did not dispatch again');
} finally {
  await context?.close();
  await close(bridge);
  fs.rmSync(runDir, { recursive: true, force: true });
}
