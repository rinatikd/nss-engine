import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8');
const start = source.indexOf('async function tabAndSite(tabId) {');
const end = source.indexOf('async function agentTab(', start);
assert.ok(start >= 0 && end > start, 'tabAndSite extraction anchors');
const fnSource = source.slice(start, end).trim();

function makeHandler(tab) {
  let siteCalls = 0;
  let deniedReads = 0;
  const context = {
    chrome: { tabs: { get: async () => tab } },
    siteOf: async (url) => { siteCalls++; return url === 'https://example.com/' ? {origin:'https://example.com', mode:'read'} : null; },
    observedOrigins: new Map(),
    grants: { grants: new Map() },
    URL,
    Error
  };
  const tabAndSite = vm.runInNewContext('(' + fnSource + ')', context);
  return { tabAndSite, siteCalls: () => siteCalls, deniedReads: () => deniedReads };
}

test('hidden URL fails closed before origin parsing or site lookup', async () => {
  const h = makeHandler({id:123,status:'complete'});
  await assert.rejects(h.tabAndSite(123), /TAB_NOT_PERMITTED/);
  assert.equal(h.siteCalls(),0);
});

test('approved tab with visible https URL is accepted', async () => {
  const h = makeHandler({id:123,url:'https://example.com/',status:'complete'});
  const result = await h.tabAndSite(123);
  assert.equal(result.site.origin,'https://example.com');
  assert.equal(h.siteCalls(),1);
});
