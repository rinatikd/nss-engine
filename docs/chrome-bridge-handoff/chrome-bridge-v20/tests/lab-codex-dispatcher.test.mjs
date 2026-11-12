import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTemporaryAdminGate } from '../server/temporary-admin-gate.mjs';
import { createLabCodexDispatcher } from '../server/lab-codex-dispatcher.mjs';

test('lab dispatcher rejects missing runner and gate', () => {
  assert.throws(() => createLabCodexDispatcher(), /LAB_RUNNER_REQUIRED/);
});
test('approved job is dispatched once and process tree reaped', async () => {
  const gate = createTemporaryAdminGate({ approve: async () => true });
  await gate.enable({ localOperator: true });
  const calls = [];
  const runner = {
    async run({requestId}) { calls.push('run:' + requestId); return { text:'OK' }; },
    async terminateTree(id) { calls.push('terminate:' + id); },
  };
  const dispatch = createLabCodexDispatcher({gate,runner});
  assert.deepEqual(await dispatch.submit({requestId:'r1',workspace:'test',prompt:'inspect'}), {text:'OK'});
  assert.deepEqual(calls,['run:r1','terminate:r1']);
  await assert.rejects(dispatch.submit({requestId:'r1',workspace:'test',prompt:'inspect'}), /DUPLICATE_REQUEST/);
});
test('denied job never reaches runner', async () => {
  const gate = createTemporaryAdminGate({approve:async ({kind})=>kind==='enable'});
  await gate.enable({localOperator:true});
  let launches=0;
  const runner={async run(){launches++;},async terminateTree(){}};
  const dispatch=createLabCodexDispatcher({gate,runner});
  await assert.rejects(dispatch.submit({requestId:'r2',workspace:'test',prompt:'inspect'}), /LOCAL_JOB_APPROVAL_REQUIRED/);
  assert.equal(launches,0);
});
test('concurrent duplicate is rejected while approval pending', async () => {
  let release;
  const gate = createTemporaryAdminGate({approve:async ({kind})=>kind==='enable' ? true : new Promise(r=>{release=r;})});
  await gate.enable({localOperator:true});
  const runner={async run(){return 'ok';},async terminateTree(){}};
  const dispatch=createLabCodexDispatcher({gate,runner});
  const args={requestId:'r3',workspace:'test',prompt:'inspect'};
  const pending=dispatch.submit(args);
  await assert.rejects(dispatch.submit(args), /DUPLICATE_REQUEST/);
  release(true);
  assert.equal(await pending,'ok');
});

test('cleanup failure blocks subsequent jobs', async () => {
  const gate = createTemporaryAdminGate({ approve: async () => true });
  await gate.enable({ localOperator: true });
  let launches = 0;
  const runner = {
    async run() { launches++; return { text: 'done' }; },
    async terminateTree() { throw Error('unconfirmed descendants'); },
  };
  const dispatch = createLabCodexDispatcher({gate,runner});
  await assert.rejects(dispatch.submit({requestId:'cleanup-1',workspace:'test',prompt:'inspect'}), /LAB_RUNNER_CLEANUP_UNCONFIRMED/);
  assert.equal(dispatch.status().cleanupFailed, true);
  await assert.rejects(dispatch.submit({requestId:'cleanup-2',workspace:'test',prompt:'inspect'}), /LAB_RUNNER_CLEANUP_UNCONFIRMED/);
  assert.equal(launches, 1);
});
