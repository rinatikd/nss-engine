// e2e: РЅР°СЃС‚РѕСЏС‰РёР№ Chromium + СЂР°СЃС€РёСЂРµРЅРёРµ + РјРѕСЃС‚ + Hub РїСЂРѕС‚РёРІ РёРјРёС‚Р°С†РёРё С‡Р°С‚-СЃР°Р№С‚РѕРІ.
// Р—Р°РїСѓСЃРє: xvfb-run -a node tests/e2e.mjs   (РЅСѓР¶РµРЅ playwright)
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { createBridge, loadConfig } from '../server/bridge.mjs';
import { mcpClient, Project, Agents, runTask, runBatch, release, initProject } from '../hub/lib.mjs';
import { startFakeChat } from './fake-chat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-'));
const ORIGIN = 'https://fake-chat.test';
let ok = 0;
const step = (m) => console.log('вЂў', m);

// СЃРµСЂС‚РёС„РёРєР°С‚
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tmp}/k.pem -out ${tmp}/c.pem -days 2 -subj /CN=fake-chat.test -addext subjectAltName=DNS:fake-chat.test 2>/dev/null`);

// РєРѕРїРёСЏ СЂР°СЃС€РёСЂРµРЅРёСЏ СЃ СЂР°Р·СЂРµС€РµРЅРёРµРј РЅР° С„РµР№РєРѕРІС‹Р№ СЃР°Р№С‚ (РІ РїСЂРѕРґР°РєС€РµРЅРµ СЂР°Р·СЂРµС€РµРЅРёРµ РІС‹РґР°С‘С‚ РєРЅРѕРїРєР° В«Р”РѕР±Р°РІРёС‚СЊ СЃР°Р№С‚В»)
const extDir = path.join(tmp, 'ext');
fs.cpSync(path.join(ROOT, 'extension'), extDir, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
mf.host_permissions.push(ORIGIN + '/*');
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicDer = publicKey.export({ type: 'spki', format: 'der' });
mf.key = publicDer.toString('base64');
const pinnedExtensionId = crypto.createHash('sha256').update(publicDer).digest().subarray(0, 16).toString('hex').replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf));

// РїРѕРІРµРґРµРЅРёРµ В«РРВ»
let revCalls = 0, chaos = false;
const fake = await startFakeChat({
  key: tmp + '/k.pem', cert: tmp + '/c.pem',
  reply(agent, text, n) {
    if (agent === 'rev') {
      if (chaos) return 'Р’РµСЂРґРёРєС‚Р° РЅРµ Р±СѓРґРµС‚.';
      if (text.includes('РџРѕРІС‚РѕСЂРё РµРіРѕ РўРћР›Р¬РљРћ')) return '```json\n{"score":9,"verdict":"accept","summary":"ok","must_fix":[],"suggestions":[]}\n```';
      if (text.includes('Р—РђР”РђРќРР•-РҐРђРћРЎ')) return 'Р‘РµР· РІРµСЂРґРёРєС‚Р° РІРѕРѕР±С‰Рµ.';
      revCalls++;
      return revCalls === 1
        ? 'Р Р°Р·Р±РѕСЂ: РЅРµС‚ С‚РµСЃС‚РѕРІ {РЅРµ json}.\n```json\n{"score":5,"verdict":"revise","summary":"РќСѓР¶РЅС‹ С‚РµСЃС‚С‹","must_fix":["РґРѕР±Р°РІРёС‚СЊ test/greet.test.js"],"suggestions":[]}\n```'
        : 'РўРµРїРµСЂСЊ С…РѕСЂРѕС€Рѕ.\n```json\n{"score":9,"verdict":"accept","summary":"ok","must_fix":[],"suggestions":[]}\n```';
    }
    if (text.includes('Р—Р°РјРµС‡Р°РЅРёСЏ СЂРµС†РµРЅР·РµРЅС‚Р°')) return '=== FILE: src/greet.js ===\nexport const greet = (n) => `РџСЂРёРІРµС‚, ${n || "РјРёСЂ"}!`;\n=== END FILE ===\n=== FILE: test/greet.test.js ===\n// tests v2\n=== END FILE ===';
    if (text.includes('РџРµСЂРµРІРѕРґ РєР°СЂС‚РѕС‡РєРё')) return `Translated by ${agent}: ` + text.match(/В«(.+?)В»/)?.[1];
    return '=== FILE: src/greet.js ===\nexport const greet = (n) => "v1";\n=== END FILE ===';
  },
});

// РјРѕСЃС‚
const stateDir = path.join(tmp, 'state');
const config = loadConfig(stateDir);
config.extensionId = pinnedExtensionId;
const bridge = createBridge(config, { stateDir, settleMs: 1200, pollMs: 400 });
await new Promise((r) => bridge.listen(17381, '127.0.0.1', r));
const client = mcpClient({ token: config.agentToken });

const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--host-resolver-rules=MAP fake-chat.test 127.0.0.1', '--ignore-certificate-errors', '--no-sandbox', '--no-proxy-server'],
});
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
assert.equal(extId, config.extensionId);
const control = await ctx.newPage();
await control.goto(`chrome-extension://${extId}/control.html`);
await control.evaluate(async (origin) => {
  await chrome.storage.local.set({ sites: { [origin]: { mode: 'chat', adapter: 'generic' } },
    adapters: JSON.stringify({ generic: { composer: '#composer', send: '#send', stop: '#stop', reply: '.assistant', newChatUrl: origin + '/dev' } }) });
}, ORIGIN);
await control.reload();
await control.fill('#token', config.browserToken);
await control.click('#connect');
await control.check('#actions');
await control.waitForFunction(() => document.getElementById('status').textContent.includes('РџРѕРґРєР»СЋС‡РµРЅРѕ'));
step('СЂР°СЃС€РёСЂРµРЅРёРµ РїРѕРґРєР»СЋС‡РµРЅРѕ Рє РјРѕСЃС‚Сѓ (long-poll)');

const dev = await ctx.newPage(); await dev.goto(ORIGIN + '/dev');
const rev = await ctx.newPage(); await rev.goto(ORIGIN + '/rev');
await control.bringToFront();

// 1. СЃС‚Р°С‚СѓСЃ, СЃРїРёСЃРѕРє, РїСЂРёРІСЏР·РєР°
assert.equal((await client.call('browser_status')).connected, true); ok++;
const lst = await client.call('agent_list');
assert.equal(lst.chatTabs.length, 2); ok++;
const tabIdOf = (u) => lst.chatTabs.find((t) => t.url.endsWith(u)).tabId;
await client.call('agent_bind', { name: 'dev', tabId: tabIdOf('/dev') });
await client.call('agent_bind', { name: 'rev', tabId: tabIdOf('/rev') });
step('Р°РіРµРЅС‚С‹ dev (contenteditable) Рё rev (textarea) РїСЂРёРІСЏР·Р°РЅС‹');

// 2. selftest + ask
const st = await client.call('agent_selftest', { name: 'dev' });
assert.equal(st.composer.visible, 1); assert.equal(st.send.matched, 1); ok++;
const a1 = await client.call('agent_ask', { name: 'dev', text: 'РїСЂРёРІРµС‚\nРІС‚РѕСЂР°СЏ СЃС‚СЂРѕРєР°', timeoutSec: 30 });
assert.equal(a1.done, true); assert.match(a1.reply, /v1/); ok++;
assert.ok(fake.received.at(-1).text.includes('РІС‚РѕСЂР°СЏ СЃС‚СЂРѕРєР°'), 'РјРЅРѕРіРѕСЃС‚СЂРѕС‡РЅС‹Р№ С‚РµРєСЃС‚ РґРѕС€С‘Р» С†РµР»РёРєРѕРј'); ok++;
step('agent_ask: РѕС‚РІРµС‚ РїРѕР»СѓС‡РµРЅ, РјРЅРѕРіРѕСЃС‚СЂРѕС‡РЅС‹Р№ РІРІРѕРґ СЂР°Р±РѕС‚Р°РµС‚');

// 3. Р±РµР·РѕРїР°СЃРЅРѕСЃС‚СЊ
await assert.rejects(client.call('agent_send', { name: 'rev', text: 'РІРѕС‚ РєР»СЋС‡ sk-abcdefghijklmnopqrstuvwxyz123456' }), /secret/); ok++;
await assert.rejects(client.call('agent_send', { name: 'nope', text: 'x' }), /Unknown agent/); ok++;
const rd = await client.call('browser_read', { tabId: tabIdOf('/dev') });
assert.match(rd.text, /Send/); ok++;
step('С„РёР»СЊС‚СЂ СЃРµРєСЂРµС‚РѕРІ Рё РїСЂРѕРІРµСЂРєР° РёРјС‘РЅ СЂР°Р±РѕС‚Р°СЋС‚');

// 4. raw click С‡РµСЂРµР· РѕРґРѕР±СЂРµРЅРёРµ РІ РѕРєРЅРµ СѓРїСЂР°РІР»РµРЅРёСЏ
const clickP = client.call('browser_fill', { tabId: tabIdOf('/rev'), selector: '#composer', text: 'СЂСѓС‡РЅРѕР№ РІРІРѕРґ' });
await control.waitForSelector('.approval', { timeout: 10000 });
assert.match(await control.textContent('.approval pre'), /textarea/);
await control.click('.approval button:not(.danger)');
assert.deepEqual(await clickP, { filled: true }); ok++;
const denyP = client.call('browser_click', { tabId: tabIdOf('/rev'), selector: '#send' });
denyP.catch(() => {});
await control.waitForSelector('.approval');
await control.click('.approval button.danger');
await assert.rejects(denyP, /denied/); ok++;
await rev.evaluate(() => { document.getElementById('composer').value = ''; });
step('РѕРґРѕР±СЂРµРЅРёРµ/РѕС‚РєР°Р· РґРµР№СЃС‚РІРёР№ РІ РѕРєРЅРµ СѓРїСЂР°РІР»РµРЅРёСЏ СЂР°Р±РѕС‚Р°СЋС‚');

// 5. С†РёРєР» Р·Р°РґР°С‡Рё: dev -> rev(revise) -> dev(revise) -> rev(accept) -> release
const proj = path.join(tmp, 'proj');
initProject(proj);
fs.writeFileSync(path.join(proj, 'agents.json'), JSON.stringify({ dev: { role: 'dev', min_gap_sec: 0 }, rev: { role: 'rev', min_gap_sec: 0 } }));
const project = new Project(proj);
const agents = new Agents(project, client);
const t = project.task('T001'); t.assignee = 'dev'; t.reviewer = 'rev'; t.new_chat = false; // Сѓ С„РµР№РєР° РѕРґРёРЅ newChatUrl РЅР° РѕР±Р° Р°РіРµРЅС‚Р°
await client.call('agent_new_chat', { name: 'dev' });
assert.equal((await client.call('agent_peek', { name: 'dev' })).count, 0); ok++; project.saveTask(t);
const res = await runTask(project, agents, 'T001');
assert.equal(res.status, 'accepted'); assert.equal(res.rounds, 2); assert.equal(res.score, 9); ok += 3;
assert.ok(fake.received.some((r) => r.agent === 'dev' && r.text.includes('РґРѕР±Р°РІРёС‚СЊ test/greet.test.js')), 'Р·Р°РјРµС‡Р°РЅРёСЏ РґРѕС€Р»Рё РґРѕ РёСЃРїРѕР»РЅРёС‚РµР»СЏ'); ok++;
const rel = release(project, { name: 'v1' });
assert.equal(rel.files, 2);
assert.match(fs.readFileSync(path.join(proj, 'release/v1/test/greet.test.js'), 'utf8'), /tests v2/); ok++;
step('С†РёРєР» СЂРµРІСЊСЋ: 2 СЂР°СѓРЅРґР° в†’ accepted в†’ release (2 С„Р°Р№Р»Р°)');

// 6. batch (РѕРґРЅР° РїР°СЂР° Р°РіРµРЅС‚РѕРІ, 2 Р·Р°РґР°РЅРёСЏ)
const batch = { id: 'B001', template: { title: 'РџРµСЂРµРІРѕРґ {{name}}', brief: 'РџРµСЂРµРІРѕРґ РєР°СЂС‚РѕС‡РєРё В«{{name}}В»', acceptance: ['ok'], output_files: false, output_path: 'tr/{{name}}.md', max_rounds: 2, new_chat: false }, items: [{ name: 'lamp' }, { name: 'chair' }], assignees: ['dev'], reviewers: ['rev'] };
revCalls = 1; // СЃР»РµРґСѓСЋС‰РёРµ СЂРµРІСЊСЋ вЂ” СЃСЂР°Р·Сѓ accept
const br = await runBatch(project, agents, batch);
assert.deepEqual(br.map((r) => r.status).sort(), ['accepted', 'accepted']); ok++;
release(project, { name: 'v2' });
assert.match(fs.readFileSync(path.join(proj, 'release/v2/tr/lamp.md'), 'utf8'), /Translated by dev: lamp/); ok++;
step('batch: 2 Р·Р°РґР°РЅРёСЏ РїСЂРёРЅСЏС‚С‹, С„Р°Р№Р»С‹ СЂРµР»РёР·Р° СЃРѕР±СЂР°РЅС‹');

// 7. РЅРµСЂР°Р·Р±РѕСЂС‡РёРІС‹Р№ РІРµСЂРґРёРєС‚: СЃРЅР°С‡Р°Р»Р° РїРµСЂРµСЃРїСЂРѕСЃ (reformat) СЃРїР°СЃР°РµС‚, Р·Р°С‚РµРј вЂ” РїРµСЂРµРґР°С‡Р° РѕСЂРєРµСЃС‚СЂР°С‚РѕСЂСѓ
const mk = (id) => project.saveTask({ ...project.task('T001'), id, brief: 'Р—РђР”РђРќРР•-РҐРђРћРЎ', output_files: false, new_chat: false, status: 'todo', deps: [] });
mk('T002');
assert.equal((await runTask(project, agents, 'T002')).status, 'accepted'); ok++;
chaos = true; mk('T003');
const r3 = await runTask(project, agents, 'T003');
assert.equal(r3.status, 'needs_orchestrator'); assert.match(r3.note, /not parseable/); ok++;
chaos = false;
step('РїРµСЂРµСЃРїСЂРѕСЃ РІРµСЂРґРёРєС‚Р° СЂР°Р±РѕС‚Р°РµС‚; Р±РµР·РЅР°РґС‘Р¶РЅС‹Р№ СЃР»СѓС‡Р°Р№ РїРµСЂРµРґР°С‘С‚СЃСЏ РѕСЂРєРµСЃС‚СЂР°С‚РѕСЂСѓ');

// 8. РѕСЃС‚Р°РЅРѕРІРєР°
await control.click('#stop');
await new Promise((r) => setTimeout(r, 300));
await assert.rejects(client.call('browser_tabs'), /disconnected|expired/); ok++;

console.log(`\nE2E OK: ${ok} РїСЂРѕРІРµСЂРѕРє`);
await ctx.close(); bridge.close(); fake.server.close();
process.exit(0);

