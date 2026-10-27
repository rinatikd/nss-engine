import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.mjs';
import { createA2AServer } from '../src/server.mjs';
import { tmpdb } from './util.mjs';

test('HTTP API: Agent Card public, auth enforced, submit idempotent and inspectable', async (t) => {
  const { db } = tmpdb(t); const ledger = new Ledger(db); t.after(() => ledger.close());
  const token = 'test-token-that-is-at-least-32-chars';
  const server = createA2AServer({ ledger, token, agentUrl: 'http://127.0.0.1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const card = await fetch(`${base}/.well-known/agent-card.json`);
  assert.equal(card.status, 200); assert.equal((await card.json()).protocolVersion, '1.0');
  assert.equal((await fetch(`${base}/v1/tasks`)).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const payload = { id: 'http-1', contextId: 'ctx-http', recipient: 'claude', text: 'Review this.' };
  const first = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(first.status, 201); assert.equal((await first.json()).task.state, 'submitted');
  const duplicate = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).result, 'duplicate');
  const conflict = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...payload, text: 'different' }) });
  assert.equal(conflict.status, 409);
  const get = await fetch(`${base}/v1/tasks/http-1`, { headers });
  assert.equal(get.status, 200); const task = (await get.json()).task;
  assert.equal(task.id, 'http-1'); assert.equal('fence' in task, false); assert.equal('owner' in task, false);
  const events = await fetch(`${base}/v1/tasks/http-1/events`, { headers });
  assert.equal((await events.json()).events[0].kind, 'submitted');
});

test('HTTP API rejects malformed JSON and oversized bodies', async (t) => {
  const { db } = tmpdb(t); const ledger = new Ledger(db); t.after(() => ledger.close());
  const server = createA2AServer({ ledger, token: 'test-token-that-is-at-least-32-chars', maxBodyBytes: 20 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer test-token-that-is-at-least-32-chars', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(100) }) })).status, 413);
});
