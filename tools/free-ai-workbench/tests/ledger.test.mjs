import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apply,getState,replay} from '../ledger.mjs';

const id='task_001';
const create={id,action:'create',actor:'coordinator',role:'planner',title:'NSS Engine read-only smoke test',project:'NSS Engine'};
const assign={id,action:'assign',actor:'coordinator',role:'planner',owner:'gemini'};
const submit={id,action:'submit',actor:'gemini',role:'developer',evidence:'report.md SHA256:0123'};
const accept={id,action:'accept',actor:'reviewer_a',role:'reviewer',comment:'Reviewed dry-run evidence'};

test('legitimate transitions reach ACCEPTED with durable event history',()=>{
 const state=replay([create,assign,submit,accept]);
 assert.equal(state[id].state,'ACCEPTED');
 assert.equal(state[id].history.length,4);
});
test('no self-approval or silent transitions',()=>{
 assert.throws(()=>replay([create,assign,submit,{...accept,actor:'gemini'}]),/SELF_REVIEW_DENIED/);
 assert.throws(()=>replay([create,accept]),/INVALID_TRANSITION/);
 assert.throws(()=>replay([create,{...assign,role:'developer'}]),/ASSIGN_ROLE_DENIED/);
});
test('no task execution or model invocation, just local append-only events',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'free-workbench-'));
 const file=path.join(dir,'tasks.jsonl');
 try{
  for(const e of [create,assign,submit,accept])apply(file,e);
  assert.equal(getState(file)[id].state,'ACCEPTED');
  assert.equal(readFileSync(file,'utf8').trim().split('\n').length,4);
  assert.throws(()=>apply(file,accept),/INVALID_TRANSITION/);
  assert.equal(readFileSync(file,'utf8').trim().split('\n').length,4);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
