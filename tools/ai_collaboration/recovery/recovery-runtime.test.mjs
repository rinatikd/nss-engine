import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRecoveryExecutor} from './recovery-runtime.mjs';
const profile={services:[
  {id:'chrome-pr102-lab',after:[],enabled:true,autoRestore:true},
  {id:'chrome-pr102-tunnel',after:['chrome-pr102-lab'],enabled:true,autoRestore:true}
]};
const make=(overrides={})=>{
  const states={'chrome-pr102-lab':'stopped','chrome-pr102-tunnel':'stopped'};
  const starts=[],events=[],claimIds=new Set();
  const f={
    profile,
    probe:async id=>({state:states[id]}),
    start:async id=>{starts.push(id);states[id]='healthy';},
    authorize:async ({requestId})=>({approved:true,requestId}),
    journal:async e=>{
      events.push(e);
      if(e.type==='claim'){
        if(claimIds.has(e.requestId))return {claimed:false};
        claimIds.add(e.requestId);return {claimed:true};
      }
      return {recorded:true};
    },
    ...overrides
  };
  return {ex:makeRecoveryExecutor(f),states,starts,events};
};
test('local gesture required; no spawn before operator gesture',async()=>{
  const h=make();
  await assert.rejects(h.ex.recover({requestId:'recovery-0001'}),/LOCAL_OPERATOR_GESTURE_REQUIRED/);
  assert.deepEqual(h.starts,[]);
});
test('explicit recovery starts missing services in dependency order',async()=>{
  const h=make();
  const r=await h.ex.recover({requestId:'recovery-0002',operatorGesture:true});
  assert.equal(r.state,'FINISHED');
  assert.deepEqual(h.starts,['chrome-pr102-lab','chrome-pr102-tunnel']);
  assert.equal(r.outcomes['chrome-pr102-tunnel'],'HEALTHY_AFTER_START');
});
test('already healthy services are not duplicated',async()=>{
  const h=make();
  h.states['chrome-pr102-lab']='healthy';
  await h.ex.recover({requestId:'recovery-0003',operatorGesture:true});
  assert.deepEqual(h.starts,['chrome-pr102-tunnel']);
});
test('unknown or occupied observations block start',async()=>{
  const h=make();
  h.states['chrome-pr102-lab']='occupied';
  const r=await h.ex.recover({requestId:'recovery-0004',operatorGesture:true});
  assert.deepEqual(h.starts,[]);
  assert.equal(r.outcomes['chrome-pr102-tunnel'],'BLOCKED_DEPENDENCY');
});
test('DENY blocks all start actions',async()=>{
  const h=make({authorize:async()=>({approved:false})});
  const r=await h.ex.recover({requestId:'recovery-0005',operatorGesture:true});
  assert.equal(r.state,'DENIED');assert.deepEqual(h.starts,[]);
});
test('journal failure blocks specific start',async()=>{
  const h=make({journal:async e=>e.type==='claim'?{claimed:true}:{recorded:false}});
  const r=await h.ex.recover({requestId:'recovery-0006',operatorGesture:true});
  assert.equal(r.outcomes['chrome-pr102-lab'],'BLOCKED_JOURNAL');
  assert.deepEqual(h.starts,[]);
});
test('never replay a recovered request ID',async()=>{
  const h=make();
  await h.ex.recover({requestId:'recovery-0007',operatorGesture:true});
  const r=await h.ex.recover({requestId:'recovery-0007',operatorGesture:true});
  assert.equal(r.state,'DUPLICATE_OR_UNCERTAIN');
  assert.equal(h.starts.length,2);
});
