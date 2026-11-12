import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalSession } from '../extension/approval-session.js';

test('browser receiver-sensitive timers work through ApprovalSession and denial clears waiter', async () => {
  let nextId = 0;
  const active = new Set();
  function browserTimer(fn, delay) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(typeof fn, 'function');
    assert.ok(delay > 0);
    const id = ++nextId;
    active.add(id);
    return id;
  }
  function browserClear(id) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    active.delete(id);
  }
  const session = new ApprovalSession({
    now: () => 1000,
    setTimeoutImpl: browserTimer,
    clearTimeoutImpl: browserClear
  });
  const id = 'browser-receiver';
  const pending = session.request({
    id, command: 'agent_send', origin: 'https://gemini.google.com',
    tabId: 123, expires: 5000
  });
  assert.equal(session.list().length, 1);
  assert.equal(session.waiters.size, 1);
  assert.deepEqual([...active], [1]);
  assert.deepEqual(session.decide({ id, approved: false, trustedUserGesture: true }), { id, approved: false });
  await assert.rejects(pending, /USER_DENIED/);
  assert.equal(session.list().length, 0);
  assert.equal(session.waiters.size, 0);
  assert.equal(active.size, 0);
});

test('browser receiver-sensitive timer is cancelled on stop', async () => {
  const active = new Set();
  function schedule() {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    active.add(1);
    return 1;
  }
  function cancel(id) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    active.delete(id);
  }
  const session = new ApprovalSession({ now: () => 1000, setTimeoutImpl: schedule, clearTimeoutImpl: cancel });
  const pending = session.request({
    id: 'browser-stop', command: 'agent_send',
    origin: 'https://gemini.google.com', tabId: 123, expires: 5000
  });
  session.stop();
  await assert.rejects(pending, /APPROVAL_CANCELLED/);
  assert.equal(active.size, 0);
});
