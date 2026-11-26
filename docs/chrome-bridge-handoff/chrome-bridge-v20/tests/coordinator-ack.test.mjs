import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireCoordinatorAck,requestCoordinatorAck} from '../extension/coordinator-ack.js';

test('start and stop reject missing or malformed acknowledgements',()=>{
  for (const operation of ['BACKGROUND_START','BACKGROUND_STOP']) {
    for (const response of [undefined,null,{},[],{ok:false},{ok:0},{ok:'true'},{reason:'FAILED'}]) {
      assert.throws(()=>requireCoordinatorAck(response,operation),new RegExp(operation+':'));
    }
  }
});
test('explicit negative coordinator reply propagates a reason',()=>{
  assert.throws(()=>requireCoordinatorAck({ok:false,reason:'MANUAL_DISCONNECT'},'BACKGROUND_START'),/BACKGROUND_START:MANUAL_DISCONNECT/);
});
test('positive acknowledgement is accepted',()=>{
  const reply={ok:true};
  assert.equal(requireCoordinatorAck(reply,'BACKGROUND_STOP'),reply);
});

test('delayed or never-resolving coordinator reply is bounded and rejected',async()=>{
  await assert.rejects(
    requestCoordinatorAck(()=>new Promise(()=>{}),'BACKGROUND_STOP',{timeoutMs:5}),
    /BACKGROUND_STOP:ACK_TIMEOUT/
  );
  await assert.rejects(
    requestCoordinatorAck(()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true}),40)),
      'BACKGROUND_START',{timeoutMs:5}),
    /BACKGROUND_START:ACK_TIMEOUT/
  );
});
test('rejected coordinator send is not mistaken for successful ACK',async()=>{
  await assert.rejects(
    requestCoordinatorAck(()=>Promise.reject(Error('PORT_CLOSED')),'BACKGROUND_STOP',{timeoutMs:100}),
    /PORT_CLOSED/
  );
});
test('timely explicit ACK succeeds',async()=>{
  assert.deepEqual(
    await requestCoordinatorAck(()=>Promise.resolve({ok:true}),'BACKGROUND_START',{timeoutMs:100}),
    {ok:true}
  );
});
