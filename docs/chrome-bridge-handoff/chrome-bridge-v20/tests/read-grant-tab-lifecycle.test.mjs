import test from 'node:test';
import assert from 'node:assert/strict';
import { installReadGrantRevocation } from '../extension/read-grant-tab-lifecycle.js';
import { SelectedReadTabs } from '../extension/selected-read-tabs.js';

function testChrome() {
  const callbacks = { updated: null, removed: null };
  const session = {};
  const origin = 'https://grok.com';
  const url = 'https://grok.com/c/5a7944a0-0ebd-48ba-bee5-94dc04b73a6c';
  const chrome = {
    tabs: {
      get: async id => ({ id, url }),
      onUpdated: { addListener: cb => { callbacks.updated = cb; } },
      onRemoved: { addListener: cb => { callbacks.removed = cb; } }
    },
    storage: {
      local: { get: async () => ({ sites: { [origin]: { mode:'chat', adapter:'grok', selectedTabOnly: true } } }) },
      session: {
        setAccessLevel: async () => {},
        get: async key => ({ [key]: session[key] }),
        set: async values => Object.assign(session, values),
        remove: async key => { delete session[key]; }
      }
    },
    permissions: { contains: async () => true }
  };
  return { chrome, callbacks, url };
}

test('changing URL revokes a granted tab immediately, including navigation back', async () => {
  const { chrome, callbacks, url } = testChrome();
  installReadGrantRevocation(chrome);
  const scope = new SelectedReadTabs(chrome);
  await scope.grant({ tabId:17, expectedUrl:url, localGesture:true });
  callbacks.updated(17, { url:'https://grok.com/c/another' });
  // Callback schedules an async storage change; await microtasks via a fresh
  // session storage read until revocation has completed.
  for (let i=0; i<10; i++) {
    if (Object.keys(await scope.all()).length === 0) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  await assert.rejects(scope.require(17,url), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
});

test('closing a tab revokes its selected read grant', async () => {
  const { chrome, callbacks, url } = testChrome();
  installReadGrantRevocation(chrome);
  const scope = new SelectedReadTabs(chrome);
  await scope.grant({ tabId:17, expectedUrl:url, localGesture:true });
  callbacks.removed(17);
  for (let i=0; i<10; i++) {
    if (Object.keys(await scope.all()).length === 0) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  await assert.rejects(scope.require(17,url), /EXPLICIT_TAB_READ_GRANT_REQUIRED/);
});

test('non-navigation updates do not revoke the read grant', async () => {
  const { chrome, callbacks, url } = testChrome();
  installReadGrantRevocation(chrome);
  const scope = new SelectedReadTabs(chrome);
  await scope.grant({ tabId:17, expectedUrl:url, localGesture:true });
  callbacks.updated(17, { title:'renamed only' });
  await scope.require(17,url);
});
