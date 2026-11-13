import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReadOnly } from '../extension/read-only-dispatch.js';

const GROK_URL = 'https://grok.com/c/5a7944a0-0ebd-48ba-bee5-94dc04b73a6c';
const ORIGIN = 'https://grok.com';

function chromeMock({ approved = true, mode = 'chat', adapter = 'grok', url = GROK_URL } = {}) {
  let currentUrl = url;
  let injected = 0;
  const api = {
    tabs: {
      get: async () => ({ id: 42, url: currentUrl }),
      query: async () => [{ id: 42, url: currentUrl, title: 'Grok project', active: true, windowId: 7 }]
    },
    permissions: { contains: async () => approved },
    storage: { local: { get: async () => ({
      sites: { [ORIGIN]: { mode, adapter } }, adapters: '{}'
    }) } },
    scripting: { executeScript: async () => {
      injected++;
      return [{ result: { count: 1, text: 'Project update', generating: false } }];
    } }
  };
  return { api, injected: () => injected, navigate: (next) => { currentUrl = next; } };
}

test('approved Grok tab appears in read-only inventory', async () => {
  const { api } = chromeMock();
  const list = await dispatchReadOnly({ name: 'browser_tabs', args: {} }, api);
  assert.equal(list.length, 1);
  assert.equal(list[0].adapter, 'grok');
  assert.equal(list[0].mode, 'chat');
});

test('read-only agent peek works with a separately permitted Grok tab', async () => {
  const { api, injected } = chromeMock();
  const result = await dispatchReadOnly({ name: 'agent_peek', args: { tabId: 42 } }, api);
  assert.equal(result.count, 1);
  assert.equal(result.text, 'Project update');
  assert.equal(injected(), 1);
});

test('no host permission or no chat-mode approval blocks Grok discovery', async () => {
  for (const options of [{ approved: false }, { mode: 'read' }, { adapter: 'claude' }]) {
    const { api, injected } = chromeMock(options);
    await assert.rejects(
      dispatchReadOnly({ name: 'agent_peek', args: { tabId: 42 } }, api),
      /HOST_PERMISSION_MISSING|AGENT_SITE_NOT_APPROVED/
    );
    assert.equal(injected(), 0);
  }
});

test('Grok write attempts remain blocked without DOM injection', async () => {
  for (const command of ['agent_send', 'browser_fill', 'browser_click', 'agent_new_chat']) {
    const { api, injected } = chromeMock();
    await assert.rejects(
      dispatchReadOnly({ name: command, args: { tabId: 42, text: 'never send', selector: 'body' } }, api),
      /CONTROL_REQUIRES_APPROVAL_UI/
    );
    assert.equal(injected(), 0);
  }
});

test('Grok tab navigation during read fails closed', async () => {
  const state = chromeMock();
  state.api.scripting.executeScript = async () => {
    state.navigate('https://grok.com/c/different-conversation');
    return [{ result: { count: 1, text: 'Stale reply', generating: false } }];
  };
  // Hardening requirement: agent_peek must reject navigation between initial
  // tab selection and injection result, just as browser_read already does.
  await assert.rejects(
    dispatchReadOnly({ name: 'agent_peek', args: { tabId: 42 } }, state.api),
    /TAB_CHANGED_DURING_READ/
  );
});
