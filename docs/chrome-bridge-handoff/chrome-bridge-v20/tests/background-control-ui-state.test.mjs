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

test('global Control buttons switch after grant and revoke without changing experimental mode',()=>{
  const base={backgroundMode:true,connected:true,mutationEnabled:true};
  const noGrants=backgroundControlUiState({...base,activeCount:0,grantsKnown:true});
  assert.equal(noGrants.grantAllDisabled,false);
  assert.equal(noGrants.revokeAllDisabled,true);
  const active=backgroundControlUiState({...base,activeCount:2,grantsKnown:true});
  assert.equal(active.grantAllDisabled,true);
  assert.equal(active.revokeAllDisabled,false);
  const revoked=backgroundControlUiState({...base,activeCount:0,grantsKnown:true});
  assert.equal(revoked.grantAllDisabled,false);
  assert.equal(revoked.revokeAllDisabled,true);
});
test('grant state unavailable fails closed while coordinator is not reachable',()=>{
  const state=backgroundControlUiState({
    backgroundMode:true,connected:true,mutationEnabled:true,grantsKnown:false
  });
  assert.equal(state.grantAllDisabled,true);
  assert.equal(state.revokeAllDisabled,true);
});
