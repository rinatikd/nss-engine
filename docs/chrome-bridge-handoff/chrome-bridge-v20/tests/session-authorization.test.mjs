import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionAuthorization, SESSION_CAPABILITIES } from '../extension/session-authorization.js';
import { CONTROL_ORIGINS } from '../extension/permissions.js';

const allOrigins = Object.keys(CONTROL_ORIGINS);
const selectedOrigins = ['https://claude.ai', 'https://grok.com'];
const epoch = 'epoch-2026-11-22-0001';
const sessionId = 'session-2026-11-22-0001';

function fixture({ now = 1700000000000, origins = allOrigins } = {}) {
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

test('one chat-approved session grants only the explicitly selected, permissioned council origins', async () => {
  const f = fixture();
  const result = await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: selectedOrigins, bridgeEpoch: epoch
  });
  assert.equal(result.active, true);
  assert.deepEqual(result.origins, [...selectedOrigins].sort());
  assert.deepEqual(result.capabilities, [...SESSION_CAPABILITIES]);
  assert.equal(result.approvalMode, 'chat-owner-approved');
});

test('authorization rejects unknown, duplicate, Claude-less, unconfigured and unavailable origins', async () => {
  const f = fixture();
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://evil.example'], bridgeEpoch: epoch
  }), /SESSION_ORIGIN_DENIED/);
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://claude.ai', 'https://claude.ai'], bridgeEpoch: epoch
  }), /SESSION_ORIGINS_DUPLICATE/);
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 60, origins: ['https://grok.com'], bridgeEpoch: epoch
  }), /SESSION_CLAUDE_REQUIRED/);
  const missingProviders = fixture({ origins: ['https://claude.ai'] });
  await assert.rejects(missingProviders.auth.authorize({
    sessionId, durationMinutes: 60, origins: selectedOrigins, bridgeEpoch: epoch
  }), /SESSION_SITE_NOT_CONFIGURED|SESSION_ORIGIN_NOT_READY/);
});

test('session authorization is bound to exact Bridge epoch and expiry', async () => {
  const f = fixture();
  await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: allOrigins, bridgeEpoch: epoch
  });
  assert.equal((await f.auth.status(epoch)).active, true);
  // Control-page status has no Bridge command envelope; it may inspect but must not revoke.
  assert.equal((await f.auth.status()).active, true);
  assert.equal((await f.auth.status('epoch-2026-11-23-0002')).reason, 'SESSION_EPOCH_MISMATCH');
  assert.equal((await f.auth.status(epoch)).active, false);

  const g = fixture();
  await g.auth.authorize({
    sessionId, durationMinutes: 60, origins: allOrigins, bridgeEpoch: epoch
  });
  g.setNow(1700000000000 + 60 * 60 * 1000);
  assert.equal((await g.auth.status(epoch)).reason, 'SESSION_EXPIRED');
});

test('require enforces command capability, approved origin, exact tab and epoch', async () => {
  const f = fixture();
  await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: allOrigins, bridgeEpoch: epoch
  });
  assert.ok(await f.auth.require({
    origin: 'https://claude.ai', tabId: 10, command: 'agent_send', bridgeEpoch: epoch
  }));
  await assert.rejects(f.auth.require({
    origin: 'https://claude.ai', tabId: 10, command: 'browser_click', bridgeEpoch: epoch
  }), /SESSION_CAPABILITY_DENIED/);
  await assert.rejects(f.auth.require({
    origin: 'https://evil.example', tabId: 10, command: 'agent_send', bridgeEpoch: epoch
  }), /SESSION_ORIGIN_DENIED/);
  await assert.rejects(f.auth.require({
    origin: 'https://gemini.google.com', tabId: 10, command: 'agent_send', bridgeEpoch: epoch
  }), /SESSION_TAB_BINDING_MISMATCH/);
  await assert.rejects(f.auth.require({
    origin: 'https://claude.ai', tabId: 11, command: 'agent_send', bridgeEpoch: epoch
  }), /SESSION_TAB_BINDING_MISMATCH/);
});

test('explicit revoke removes temporary session lease', async () => {
  const f = fixture();
  await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: allOrigins, bridgeEpoch: epoch
  });
  await f.auth.revoke();
  assert.equal((await f.auth.status(epoch)).active, false);
  assert.equal(Object.keys(f.session).length, 0);
});

test('revoke rejects a fulfilled no-op remove and succeeds only after exact absence read-back', async () => {
  const f = fixture();
  await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: allOrigins, bridgeEpoch: epoch
  });
  const lease = f.session.bridgeSessionAuthorization;
  const remove = f.chromeApi.storage.session.remove;
  f.chromeApi.storage.session.remove = async () => {}; // resolved but deliberately leaves the lease
  await assert.rejects(f.auth.revoke(), /SESSION_REVOKE_UNCONFIRMED/);
  assert.deepEqual(f.session.bridgeSessionAuthorization, lease,
    'the failed revoke must not pretend that the persisted lease disappeared');

  f.chromeApi.storage.session.remove = remove;
  await f.auth.revoke();
  assert.equal(f.session.bridgeSessionAuthorization, undefined);
  assert.equal((await f.auth.status(epoch)).active, false);
});

test('revoke fails closed when exact lease read-back is unavailable, then permits a verified retry', async () => {
  const f = fixture();
  await f.auth.authorize({
    sessionId, durationMinutes: 60, origins: allOrigins, bridgeEpoch: epoch
  });
  const get = f.chromeApi.storage.session.get;
  f.chromeApi.storage.session.get = async key => {
    if (key === 'bridgeSessionAuthorization') throw Error('SYNTHETIC_REVOKE_READBACK_UNAVAILABLE');
    return get(key);
  };
  await assert.rejects(f.auth.revoke(), /SESSION_REVOKE_UNCONFIRMED/);
  assert.equal(f.session.bridgeSessionAuthorization, undefined,
    'the lease may have been removed, but an unavailable read-back cannot be acknowledged');
  f.chromeApi.storage.session.get = get;
  await f.auth.revoke();
  assert.equal(f.session.bridgeSessionAuthorization, undefined);
});

test('revoke fails closed when secure session storage cannot be established', async () => {
  const f = fixture();
  delete f.chromeApi.storage.session.setAccessLevel;
  await assert.rejects(f.auth.revoke(), /SECURE_SESSION_STORAGE_REQUIRED/);
});

test('invalid IDs, duration and epoch fail closed', async () => {
  const f = fixture();
  await assert.rejects(f.auth.authorize({
    sessionId: 'bad', durationMinutes: 60, origins: allOrigins, bridgeEpoch: epoch
  }), /SESSION_ID_INVALID/);
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 30, origins: allOrigins, bridgeEpoch: epoch
  }), /SESSION_DURATION_INVALID/);
  await assert.rejects(f.auth.authorize({
    sessionId, durationMinutes: 60, origins: allOrigins, bridgeEpoch: 'short'
  }), /BRIDGE_EPOCH_INVALID/);
});

test('secure session storage is required', async () => {
  const f = fixture();
  delete f.chromeApi.storage.session.setAccessLevel;
  await assert.rejects(f.auth.status(epoch), /SECURE_SESSION_STORAGE_REQUIRED/);
});

test('a stale lease from the previous Bridge epoch is revoked before fresh authorization', async () => {
  const f = fixture();
  await f.auth.authorize({sessionId,durationMinutes:60,origins:allOrigins,bridgeEpoch:epoch});
  const nextEpoch = 'epoch-2026-11-23-0002';
  const next = await f.auth.authorize({
    sessionId:'session-2026-11-23-0002',durationMinutes:60,origins:allOrigins,bridgeEpoch:nextEpoch
  });
  assert.equal(next.active, true);
  assert.equal(next.bridgeEpoch, nextEpoch);
});

test('an active lease in the same Bridge epoch cannot be overwritten', async () => {
  const f = fixture();
  await f.auth.authorize({sessionId,durationMinutes:60,origins:allOrigins,bridgeEpoch:epoch});
  await assert.rejects(f.auth.authorize({
    sessionId:'session-2026-11-22-0002',durationMinutes:60,origins:allOrigins,bridgeEpoch:epoch
  }), /SESSION_ALREADY_ACTIVE/);
});
