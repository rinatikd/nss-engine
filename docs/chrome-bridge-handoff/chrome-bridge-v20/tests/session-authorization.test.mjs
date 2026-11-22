import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionAuthorization, SESSION_CAPABILITIES } from '../extension/session-authorization.js';
import { CONTROL_ORIGINS } from '../extension/permissions.js';

function fixture({ now = 1700000000000, origins = Object.keys(CONTROL_ORIGINS) } = {}) {
  let clock = now;
  const session = {};
  const allowed = new Set(origins);
  const sites = Object.fromEntries(Object.entries(CONTROL_ORIGINS)
    .filter(([origin]) => allowed.has(origin))
    .map(([origin, adapter]) => [origin, { mode: 'chat', adapter }]));
  const tabs = Object.entries(CONTROL_ORIGINS)
    .filter(([origin]) => allowed.has(origin))
    .map(([origin], index) => ({ id: index + 10, url: origin + '/chat/test' }));
  const chromeApi = {
    tabs: {
      query: async () => tabs,
      get: async id => tabs.find(tab => tab.id === id) || null
    },
    storage: {
      local: { get: async () => ({ sites }) },
      session: {
        setAccessLevel: async value => assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'),
        get: async key => ({ [key]: session[key] }),
        set: async value => Object.assign(session, value),
        remove: async key => { delete session[key]; }
      }
    },
    permissions: { contains: async ({ origins: requested }) => requested.every(item =>
      [...allowed].some(origin => item === origin + '/*')) }
  };
  const auth = new SessionAuthorization(chromeApi, { now: () => clock });
  return { auth, chromeApi, session, tabs, setNow: value => { clock = value; } };
}
const epoch = 'epoch-2026-11-22-0001';
const sessionId = 'session-2026-11-22-0001';

test('one chat-approved session grants only configured, permissioned council origins', async () => {
  const f = fixture();
  const origins = Object.keys(CONTROL_ORIGINS);
  const result = await f.auth.authorize({ sessionId, durationMinutes: 60, origins, bridgeEpoch: epoch });
  assert.equal(result.active, true);
  assert.deepEqual(result.origins, origins.sort());
  assert.deepEqual(result.capabilities, [...SESSION_CAPABILITIES]);
  assert.equal(result.approvalMode, 'chat-owner-approved');
});

test('session authorization rejects unknown, duplicate, unconfigured and unavailable origins', async () => {
  const f = fixture();
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://evil.example'], bridgeEpoch: epoch
  }), /SESSION_ORIGIN_DENIED/);
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://claude.ai', 'https://claude.ai'], bridgeEpoch: epoch
  }), /SESSION_ORIGINS_DUPLICATE/);
  const noClaude = fixture({ origins: ['https://gemini.google.com'] });
  await assert.rejects(noClaude.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://claude.ai'], bridgeEpoch: epoch
  }), /SESSION_SITE_NOT_CONFIGURED|SESSION_ORIGIN_NOT_READY/);
});

test('session authorization is bound to the exact Bridge epoch and expires', async () => {
  const f = fixture();
  await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://claude.ai'], bridgeEpoch: epoch
  });
  assert.equal((await f.auth.status(epoch)).active, true);
  assert.equal((await f.auth.status('epoch-2026-11-23-0002')).reason, 'SESSION_EPOCH_MISMATCH');
  assert.equal(await f.auth.status(epoch).then(x => x.active), false);
  const g = fixture();
  await g.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://claude.ai'], bridgeEpoch: epoch
  });
  g.setNow(1700000000000 + 60 * 60 * 1000);
  assert.equal((await g.auth.status(epoch)).reason, 'SESSION_EXPIRED');
});

test('require enforces command capability, approved origin, exact tab and current epoch', async () => {
  const f = fixture();
  await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://claude.ai'], bridgeEpoch: epoch
  });
  assert.ok(await f.auth.require({
    origin: 'https://claude.ai', tabId: 10, command: 'agent_send', bridgeEpoch: epoch
  }));
  await assert.rejects(f.auth.require({
    origin: 'https://claude.ai', tabId: 10, command: 'browser_click', bridgeEpoch: epoch
  }), /SESSION_CAPABILITY_DENIED/);
  await assert.rejects(f.auth.require({
    origin: 'https://gemini.google.com', tabId: 10, command: 'agent_send', bridgeEpoch: epoch
  }), /SESSION_ORIGIN_DENIED/);
  await assert.rejects(f.auth.require({
    origin: 'https://claude.ai', tabId: 11, command: 'agent_send', bridgeEpoch: epoch
  }), /SESSION_TAB_BINDING_MISMATCH/);
});

test('explicit revoke removes the temporary session lease', async () => {
  const f = fixture();
  await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://claude.ai'], bridgeEpoch: epoch
  });
  await f.auth.revoke();
  assert.equal((await f.auth.status(epoch)).active, false);
  assert.equal(Object.keys(f.session).length, 0);
});

test('invalid IDs, duration, epoch and unavailable secure session storage fail closed', async () => {
  const f = fixture();
  await assert.rejects(f.auth.authorize({
    sessionId: 'bad', durationMinutes: 60, origins: ['https://claude.ai'], bridgeEpoch: epoch
  }), /SESSION_ID_INVALID/);
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 30, origins: ['https://claude.ai'], bridgeEpoch: epoch
  }), /SESSION_DURATION_INVALID/);
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://claude.ai'], bridgeEpoch: 'short'
  }), /BRIDGE_EPOCH_INVALID/);
});

test('session authorization refuses an unavailable secure session store', async () => {
 const f=fixture();
 delete f.chromeApi.storage.session.setAccessLevel;
 await assert.rejects(f.auth.status(epoch),/SECURE_SESSION_STORAGE_REQUIRED/);
});
