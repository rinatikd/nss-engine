import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireCoordinatorAck} from '../extension/coordinator-ack.js';

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
