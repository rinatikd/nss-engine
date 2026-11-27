import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserKey, saveBrowserKey, forgetBrowserKey } from '../extension/browser-key-store.js';

function fakeChrome({ trustedStorage = true } = {}) {
  const local = new Map(), session = new Map();
  let restricted = false;
  const area = (map) => ({
    async get(key) { return { [key]: map.get(key) }; },
    async set(data) { for (const [key, value] of Object.entries(data)) map.set(key, value); },
    async remove(key) { map.delete(key); }
  });
  const localArea = area(local);
  if (trustedStorage) localArea.setAccessLevel = async ({ accessLevel }) => {
    assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); restricted = true;
  };
  return { api: { storage: { local: localArea, session: area(session) } },
    local, session, isRestricted: () => restricted };
}

test('key persists in restricted local storage and is restored after session loss', async () => {
  const f = fakeChrome();
  await saveBrowserKey(f.api, '  example-secret-not-a-real-token  ');
  assert.equal(f.isRestricted(), true);
  assert.equal(f.local.get('browserToken'), 'example-secret-not-a-real-token');
  assert.equal(f.session.has('browserToken'), false);
  assert.deepEqual(await loadBrowserKey(f.api), { value: 'example-secret-not-a-real-token', persistent: true });
});

test('legacy temporary session key is loaded but not automatically persisted', async () => {
  const f = fakeChrome();
  f.session.set('browserToken', 'legacy-key');
  assert.deepEqual(await loadBrowserKey(f.api), { value: 'legacy-key', persistent: false });
  assert.equal(f.local.has('browserToken'), false);
  await saveBrowserKey(f.api, 'legacy-key');
  assert.equal(f.local.get('browserToken'), 'legacy-key');
  assert.equal(f.session.has('browserToken'), false);
});

test('removing the browser key clears both storage areas', async () => {
  const f = fakeChrome();
  f.local.set('browserToken', 'local-key');
  f.session.set('browserToken', 'session-key');
  await forgetBrowserKey(f.api);
  assert.deepEqual(await loadBrowserKey(f.api), { value: '', persistent: false });
});

test('cannot persist credentials if trusted-only storage is unavailable', async () => {
  const f = fakeChrome({ trustedStorage: false });
  await assert.rejects(saveBrowserKey(f.api, 'key'), /SECURE_STORAGE_UNAVAILABLE/);
  assert.equal(f.local.has('browserToken'), false);
});

test('empty keys rejected and never replace a saved key', async () => {
  const f = fakeChrome();
  await saveBrowserKey(f.api, 'valid-key');
  await assert.rejects(saveBrowserKey(f.api, '  '), /BROWSER_KEY_REQUIRED/);
  assert.equal(f.local.get('browserToken'), 'valid-key');
});
