import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReadOnly } from '../extension/read-only-dispatch.js';

function chromeFixture() {
  let scriptCalls = 0;
  const tabs = [
    { id: 1, url: 'https://example.com/', title: 'Public example', active: true, windowId: 10 },
    { id: 2, url: 'https://unapproved.example/', title: 'Sensitive unapproved tab', active: false, windowId: 10 },
    { id: 3, url: 'http://127.0.0.1:17481/', title: 'Loopback', active: false, windowId: 10 }
  ];
  const c = {
    tabs: {
      query: async () => tabs,
      get: async id => tabs.find(t => t.id === id)
    },
    storage: {local: {
      get: async () => ({ sites: { 'https://example.com': { mode: 'read' } } })
    }},
    permissions: {
      contains: async ({ origins }) => origins[0] === 'https://example.com/*'
    },
    scripting: {
      executeScript: async ({ target }) => {
        scriptCalls++;
        assert.equal(target.tabId, 1);
        return [{result: {text: 'Safe example page', links: []}}];
      }
    }
  };
  return {chrome: c, getScriptCalls: () => scriptCalls};
}

test('browser_tabs exposes only explicitly allowed https origins', async () => {
  const {chrome} = chromeFixture();
  const tabs = await dispatchReadOnly({name:'browser_tabs',args:{}}, chrome);
  assert.equal(tabs.length,1);
  assert.equal(tabs[0].tabId,1);
  assert.equal(tabs[0].origin,'https://example.com');
  assert.equal(JSON.stringify(tabs).includes('unapproved.example'),false);
  assert.equal(JSON.stringify(tabs).includes('127.0.0.1'),false);
});

test('browser_read rejects unapproved and local tabs without injection', async () => {
  const {chrome,getScriptCalls} = chromeFixture();
  for (const tabId of [2,3]) {
    await assert.rejects(
      dispatchReadOnly({name:'browser_read',args:{tabId}},chrome),
      /ORIGIN_NOT_PERMITTED/
    );
  }
  assert.equal(getScriptCalls(),0);
});

test('background read-only dispatch rejects mutations without executing scripts', async () => {
  const {chrome,getScriptCalls} = chromeFixture();
  for (const name of ['browser_click','browser_fill','agent_send','agent_new_chat','browser_open']) {
    await assert.rejects(
      dispatchReadOnly({name,args:{tabId:1}},chrome),
      /CONTROL_REQUIRES_APPROVAL_UI/
    );
  }
  assert.equal(getScriptCalls(),0);
});

test('browser_read returns permitted page and no extra scripting on denied request', async () => {
  const {chrome,getScriptCalls} = chromeFixture();
  const result = await dispatchReadOnly({name:'browser_read',args:{tabId:1}},chrome);
  assert.equal(result.text,'Safe example page');
  assert.deepEqual(result.links,[]);
  assert.equal(getScriptCalls(),1);
  await assert.rejects(
    dispatchReadOnly({name:'browser_read',args:{tabId:2}},chrome),
    /ORIGIN_NOT_PERMITTED/
  );
  assert.equal(getScriptCalls(),1);
});

test('browser_tabs refuses a configured origin when Chrome host permission is revoked', async () => {
  const {chrome} = chromeFixture();
  chrome.permissions.contains = async () => false;
  assert.deepEqual(await dispatchReadOnly({name:'browser_tabs',args:{}},chrome),[]);
  await assert.rejects(
    dispatchReadOnly({name:'browser_read',args:{tabId:1}},chrome),
    /HOST_PERMISSION_MISSING/
  );
});
