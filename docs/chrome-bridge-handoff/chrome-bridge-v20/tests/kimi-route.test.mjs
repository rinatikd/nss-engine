import test from 'node:test';
import assert from 'node:assert/strict';
import { pageAction } from '../extension/page.js';

async function inRoute(origin, pathname, search = '', hash = '', work) {
  const prior = globalThis.location;
  globalThis.location = { origin, pathname, search, hash };
  try { return await work(); }
  finally {
    if (prior === undefined) delete globalThis.location;
    else globalThis.location = prior;
  }
}

test('Kimi accepts only an explicit /chat/<opaque-id> as a conversation context', async () => {
  await inRoute('https://www.kimi.ai', '/chat/abcdefgh12345678', '', '', async () => {
    const result = await pageAction('agent_context', {}, 'https://www.kimi.ai');
    assert.deepEqual(result, {
      verified: true,
      origin: 'https://www.kimi.ai',
      conversationId: 'abcdefgh12345678',
      bootstrap: false
    });
  });
});

test('Kimi home, new-chat and login routes do not fabricate conversation IDs', async () => {
  for (const pathname of ['/', '/new', '/login', '/chat']) {
    await inRoute('https://www.kimi.ai', pathname, '', '', async () => {
      const result = await pageAction('agent_context', {}, 'https://www.kimi.ai');
      assert.equal(result.verified, false, pathname);
      assert.equal(result.conversationId, null, pathname);
      assert.equal(result.bootstrap, false, pathname);
    });
  }
});

test('Kimi query, fragment, and malformed chat identifiers fail closed', async () => {
  for (const [pathname, search, hash] of [
    ['/chat/abcdefgh12345678', '?workspace=other', ''],
    ['/chat/abcdefgh12345678', '', '#other'],
    ['/chat/short', '', ''],
    ['/chat/invalid.id.123', '', '']
  ]) {
    await inRoute('https://www.kimi.ai', pathname, search, hash, async () => {
      const result = await pageAction('agent_context', {}, 'https://www.kimi.ai');
      assert.equal(result.verified, false, pathname + search + hash);
    });
  }
});

test('Kimi adapter remains non-sendable until live selectors are calibrated', async () => {
  const { DEFAULT_ADAPTERS } = await import('../extension/adapters.js');
  assert.equal(DEFAULT_ADAPTERS.kimi.origin, 'https://www.kimi.ai');
  assert.equal(DEFAULT_ADAPTERS.kimi.send, '');
  assert.equal(DEFAULT_ADAPTERS.kimi.reply, '');
});
