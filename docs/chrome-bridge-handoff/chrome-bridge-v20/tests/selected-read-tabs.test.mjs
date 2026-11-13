import test from 'node:test';
import assert from 'node:assert/strict';
import { SelectedReadTabs } from '../extension/selected-read-tabs.js';
import { dispatchReadOnly } from '../extension/read-only-dispatch.js';

const origin = 'https://grok.com';
const initial = 'https://grok.com/c/5a7944a0-0ebd-48ba-bee5-94dc04b73a6c';
function setup({ hostGranted = true, scoped = true } = {}) {
  const state = { url: initial, now: 1000, session: {} };
  const api = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: state.url }),
      query: async () => [{ id: 17, url: state.url, title: 'Grok project', active: false, windowId: 1 }]
    },
    storage: {
      local: { get: async () => ({ sites: { [origin]: {
        mode: 'chat', adapter: 'grok', selectedTabOnly: scoped
      } }, adapters: '{}' }) },
      session: {
        setAccessLevel: async ({ accessLevel }) => assert.equal(accessLevel, 'TRUSTED_CONTEXTS'),
        get: async (key) => ({ [key]: state.session[key] }),
        set: async (values) => Object.assign(state.session, values),
        remove: async (key) => { delete state.session[key]; }
      }
    },
    permissions: { contains: async () => hostGranted },
    scripting: { executeScript: async () => [{ result: { count: 1, text: 'safe reply', generating: false } }] }
  };
  return { api, state, reader: new SelectedReadTabs(api, { now: () => state.now }) };
}

test('no tab read consent is fail closed in MCP and direct helper', async () => {
  const { api, reader } = setup();
  await assert.rejects(reader.require(17, initial), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
  assert.deepEqual(await dispatchReadOnly({ name: 'browser_tabs', args: {} }, api), []);
  await assert.rejects(
    dispatchReadOnly({ name: 'agent_peek', args: { tabId: 17 } }, api),
    /EXPLICIT_TAB_READ_GRANT_REQUIRED/
  );
});

test('exact URL and local gesture required; user grant is one tab, one URL', async () => {
  const { state, reader } = setup();
  await assert.rejects(reader.grant({ tabId: 17, expectedUrl: initial, localGesture: false }),
    /LOCAL_GESTURE_REQUIRED/);
  await assert.rejects(reader.grant({ tabId: 17, expectedUrl: 'https://grok.com/c/other', localGesture: true }),
    /TAB_CHANGED_BEFORE_GRANT/);
  const grant = await reader.grant({ tabId: 17, expectedUrl: initial, localGesture: true });
  assert.equal(grant.origin, origin);
  await reader.require(17, initial);
  await assert.rejects(reader.require(18, initial), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
  state.url = 'https://grok.com/c/different';
  await assert.rejects(reader.require(17, state.url), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
});

test('expiry and explicit revocation deny future reads', async () => {
  const { state, reader } = setup();
  await reader.grant({ tabId: 17, expectedUrl: initial, localGesture: true });
  state.now += 60 * 60000;
  await assert.rejects(reader.require(17, initial), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
  state.now = 1000;
  await reader.grant({ tabId: 17, expectedUrl: initial, localGesture: true });
  await reader.revoke(17);
  await assert.rejects(reader.require(17, initial), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
});

test('host permission and site-specific scoping required for enrollment', async () => {
  for (const options of [{ hostGranted: false }, { scoped: false }]) {
    const { reader } = setup(options);
    await assert.rejects(
      reader.grant({ tabId: 17, expectedUrl: initial, localGesture: true }),
      /HOST_PERMISSION_MISSING|SCOPED_SITE_REQUIRED/
    );
  }
});

test('scoped tab grant never authorizes agent_send or click', async () => {
  const { api, reader } = setup();
  await reader.grant({ tabId: 17, expectedUrl: initial, localGesture: true });
  for (const name of ['agent_send', 'browser_click', 'browser_fill']) {
    await assert.rejects(dispatchReadOnly({
      name, args: { tabId: 17, text: 'do not send', selector: 'body' }
    }, api), /CONTROL_REQUIRES_APPROVAL_UI/);
  }
});

test('site revocation clears all matching tabs without removing unrelated ones', async () => {
  const { reader } = setup();
  await reader.grant({ tabId: 17, expectedUrl: initial, localGesture: true });
  await reader.revokeOrigin(origin);
  await assert.rejects(reader.require(17, initial), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
  await reader.grant({ tabId: 17, expectedUrl: initial, localGesture: true });
  await reader.clear();
  await assert.rejects(reader.require(17, initial), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
});
