import test from 'node:test';
import assert from 'node:assert/strict';
import {translateOpenAgentsTask, DispatchGate} from './openagents-adapter.mjs';
const root='C:\\Engineering';
const valid={taskId:'task_12345678',agent:'codex',operation:'node-test',workspace:root,approvalState:'approved'};
const opts={allowedRoots:[root]};
test('valid bounded request',()=>{const x=translateOpenAgentsTask(valid,opts);assert.equal(x.operation,'node-test');assert.match(x.requestId,/^oa_[a-f0-9]{32}$/)});
for (const [field,value] of [['approvalState','pending'],['operation','powershell-script'],['workspace','C:\\Secrets'],['agent','unknown'],['taskId','bad']]) {
  test('reject '+field,()=>assert.throws(()=>translateOpenAgentsTask({...valid,[field]:value},opts)));
}
test('deduplicates before submit',async()=>{let n=0;const gate=new DispatchGate(async()=>{n++;return {ok:true}},opts);assert.equal((await gate.dispatch(valid)).state,'submitted');assert.equal((await gate.dispatch(valid)).state,'duplicate');assert.equal(n,1)});
test('unknown submit outcome not retried',async()=>{let n=0;const gate=new DispatchGate(async()=>{n++;throw Error('offline')},opts);assert.equal((await gate.dispatch(valid)).state,'unknown');assert.equal((await gate.dispatch(valid)).state,'duplicate');assert.equal(n,1)});
