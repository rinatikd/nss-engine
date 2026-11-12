import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryAdminGate } from '../server/temporary-admin-gate.mjs';

test('disabled by default, local operator required', async () => {
  const gate = createTemporaryAdminGate({ approve: async () => true });
  assert.equal(gate.status().enabled, false);
  await assert.rejects(gate.enable(), /LOCAL_OPERATOR_REQUIRED/);
  await assert.rejects(gate.authorizeJob({requestId:'1',workspace:'x',prompt:'test'}), /ADMIN_SESSION_INACTIVE/);
});
test('local approval required per job and expires', async () => {
  let time = 1000; let approved = false; const events = [];
  const gate = createTemporaryAdminGate({ now: () => time, approve: async () => approved, audit: e => events.push(e), maxSessionMs: 1000 });
  assert.equal(await gate.enable({localOperator:true}), false);
  approved = true;
  assert.equal(await gate.enable({localOperator:true}), true);
  approved = false;
  await assert.rejects(gate.authorizeJob({requestId:'2',workspace:'x',prompt:'test'}), /LOCAL_JOB_APPROVAL_REQUIRED/);
  approved = true;
  const ticket = await gate.authorizeJob({requestId:'3',workspace:'x',prompt:'test'});
  assert.ok(ticket.requestHash);
  time += 1000;
  assert.equal(gate.status().enabled, false);
  await assert.rejects(gate.authorizeJob({requestId:'4',workspace:'x',prompt:'test'}), /ADMIN_SESSION_INACTIVE/);
  assert.ok(events.some(e => e.event === 'job_approved'));
});
test('timeout is capped', async () => {
  const gate = createTemporaryAdminGate({approve:async()=>true});
  await gate.enable({localOperator:true});
  await assert.rejects(gate.authorizeJob({requestId:'5',workspace:'x',prompt:'test',timeoutSec:301}), /INVALID_ADMIN_JOB/);
});

test('ticket is single-use and bound to exact request', async () => {
  const gate = createTemporaryAdminGate({ approve: async () => true });
  await gate.enable({localOperator:true});
  const args = {requestId:'request-a',workspace:'project-a',prompt:'inspect',timeoutSec:30};
  const grant = await gate.authorizeJob(args);
  assert.throws(() => gate.consumeJob({...args,prompt:'modified',ticket:grant.ticket}), /ADMIN_TICKET_MISMATCH/);
  assert.throws(() => gate.consumeJob({...args,ticket:grant.ticket}), /ADMIN_TICKET_INVALID/);
  const next = await gate.authorizeJob(args);
  assert.equal(gate.consumeJob({...args,ticket:next.ticket}),true);
  assert.throws(() => gate.consumeJob({...args,ticket:next.ticket}), /ADMIN_TICKET_INVALID/);
});
test('disable revokes outstanding tickets', async () => {
  const gate = createTemporaryAdminGate({ approve: async () => true });
  await gate.enable({localOperator:true});
  const args = {requestId:'request-b',workspace:'project-b',prompt:'inspect'};
  const grant = await gate.authorizeJob(args);
  gate.disable();
  assert.throws(() => gate.consumeJob({...args,ticket:grant.ticket}), /ADMIN_TICKET_INVALID/);
});
