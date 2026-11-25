import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFailure,normalizeFailure,safeFailureCode} from '../server/failure-contract.mjs';

test('failure contract has exact schema and bounded elapsed time',()=>{
  let now=1500;
  assert.deepEqual(makeFailure('PAGE_ACTION','PROVIDER_SEND_BUTTON_NOT_READY',1000,()=>now),{
    schemaVersion:1,stage:'PAGE_ACTION',code:'PROVIDER_SEND_BUTTON_NOT_READY',durationMs:500
  });
  now=900000;
  assert.equal(makeFailure('PAGE_ACTION','PAGE_ACTION_FAILED',0,()=>now).durationMs,300000);
});

test('untrusted failure objects are normalized and stripped of extra fields',()=>{
  assert.deepEqual(normalizeFailure({
    schemaVersion:99,stage:'PAGE_ACTION',code:'BAD_FAILURE',durationMs:10,
    prompt:'must not leak',url:'https://private.example'
  },{stage:'TRANSPORT',code:'DISPATCH_FAILED',startedAt:100,now:()=>125}),{
    schemaVersion:1,stage:'TRANSPORT',code:'DISPATCH_FAILED',durationMs:25
  });
  assert.equal(safeFailureCode('Command expired before dispatch.'),'COMMAND_EXPIRED');
  assert.equal(safeFailureCode('Chrome disconnected: detail'),'CHROME_DISCONNECTED');
  assert.equal(safeFailureCode('Previous request is still pending: call agent_wait first.'),'PREVIOUS_REQUEST_PENDING');
  assert.equal(safeFailureCode('Command expired after dispatch; execution remains quarantined.'),'COMMAND_TIMEOUT_AFTER_DISPATCH');
});
