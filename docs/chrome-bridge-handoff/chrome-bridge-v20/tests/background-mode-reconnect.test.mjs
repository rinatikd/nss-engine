import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backgroundStartupDecision} from '../extension/background-mode-reconnect.js';

test('mode re-entry after explicit Stop never auto-starts the coordinator',()=>{
  assert.equal(backgroundStartupDecision({connectionDesired:false,hasSavedKey:true}),'await-connect');
});
test('missing browser key requires an explicit authenticated Connect',()=>{
  assert.equal(backgroundStartupDecision({connectionDesired:true,hasSavedKey:false}),'await-connect');
});
test('existing desired connection with stored key can be resumed',()=>{
  assert.equal(backgroundStartupDecision({connectionDesired:true,hasSavedKey:true}),'start');
});
test('default re-entry is disconnected, not a failed start',()=>{
  assert.equal(backgroundStartupDecision(),'await-connect');
});
