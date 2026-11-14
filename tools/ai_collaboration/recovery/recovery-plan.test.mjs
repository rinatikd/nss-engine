import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryPlan,validateRecoveryProfile} from './recovery-plan.mjs';

const profile={services:[
  {id:'chrome-prod-server',after:[],enabled:true,autoRestore:true},
  {id:'chrome-prod-mcp',after:['chrome-prod-server'],enabled:true,autoRestore:true},
  {id:'chrome-pr102-lab',after:[],enabled:true,autoRestore:true},
  {id:'chrome-pr102-tunnel',after:['chrome-pr102-lab'],enabled:true,autoRestore:true},
  {id:'powershell-direct',after:[],enabled:true,autoRestore:true},
  {id:'powershell-direct-tunnel',after:['powershell-direct'],enabled:true,autoRestore:true}
]};
const observations={
  'chrome-prod-server':{state:'healthy'},
  'chrome-prod-mcp':{state:'stopped'},
  'chrome-pr102-lab':{state:'stopped'},
  'chrome-pr102-tunnel':{state:'stopped'},
  'powershell-direct':{state:'healthy'},
  'powershell-direct-tunnel':{state:'stopped'}
};
test('never start anything without an explicit requested restore',()=>{
  const result=recoveryPlan(profile,observations);
  assert.deepEqual(result.actions,[]);
  assert.equal(result.outcomes['chrome-pr102-lab'],'STOPPED_NOT_AUTHORIZED');
});
test('start only missing services in dependency order, never duplicate healthy servers',()=>{
  const {actions,outcomes}=recoveryPlan(profile,observations,{requested:true});
  assert.deepEqual(actions.map(x=>x.id),[
    'chrome-prod-mcp','chrome-pr102-lab','chrome-pr102-tunnel','powershell-direct-tunnel'
  ]);
  assert.equal(outcomes['chrome-prod-server'],'ALREADY_HEALTHY');
});
test('occupied/unknown/unhealthy port is NEVER treated as safe to start or kill',()=>{
  for(const state of ['occupied','unknown','unhealthy']){
    const input={...observations,'chrome-pr102-lab':{state}};
    const r=recoveryPlan(profile,input,{requested:true});
    assert.equal(r.actions.some(x=>x.id==='chrome-pr102-lab'),false);
    assert.equal(r.actions.some(x=>x.id==='chrome-pr102-tunnel'),false);
  }
});
test('missing trusted ownership observation fails closed',()=>{
  const r=recoveryPlan(profile,{}, {requested:true});
  assert.deepEqual(r.actions,[]);
});
test('disabled auto restore never starts on one-click',()=>{
  const modified={services:profile.services.map(s=>s.id==='chrome-pr102-lab'?{...s,autoRestore:false}:s)};
  const r=recoveryPlan(modified,observations,{requested:true});
  assert.equal(r.actions.some(x=>x.id==='chrome-pr102-lab'),false);
});
test('detect cycles and unknown dependencies',()=>{
  assert.throws(()=>validateRecoveryProfile({services:[
    {id:'chrome-pr102-lab',after:['chrome-prod-mcp'],enabled:true,autoRestore:true},
    {id:'chrome-prod-mcp',after:['chrome-pr102-lab'],enabled:true,autoRestore:true}
  ]}),/CYCLIC_DEPENDENCIES/);
  assert.throws(()=>validateRecoveryProfile({services:[
    {id:'chrome-pr102-lab',after:['chrome-prod-mcp'],enabled:true,autoRestore:true}
  ]}),/MISSING_DEPENDENCY/);
});
