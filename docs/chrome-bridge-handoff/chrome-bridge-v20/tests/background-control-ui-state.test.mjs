import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backgroundControlUiState} from '../extension/background-control-ui-state.js';

test('Control button remains disabled outside background mode',()=>{
  assert.equal(backgroundControlUiState({connected:true,mutationEnabled:true}).grantAllDisabled,true);
});
test('Control button remains disabled when bridge is disconnected',()=>{
  const state=backgroundControlUiState({backgroundMode:true,connected:false,mutationEnabled:true});
  assert.equal(state.grantAllDisabled,true);
  assert.match(state.reason,/подключите/);
});
test('Control button remains disabled until experimental control is enabled',()=>{
  assert.equal(backgroundControlUiState({backgroundMode:true,connected:true,mutationEnabled:false}).grantAllDisabled,true);
});
test('Control button enables only when all three conditions hold',()=>{
  const state=backgroundControlUiState({backgroundMode:true,connected:true,mutationEnabled:true});
  assert.equal(state.grantAllDisabled,false);
});
