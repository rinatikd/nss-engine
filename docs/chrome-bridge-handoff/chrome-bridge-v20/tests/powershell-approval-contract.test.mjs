import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeTask,verifyApprovedTask } from '../server/powershell-approval-contract.mjs';
const workspace='C:\\Engineering\\ChromeBridge-Main-17485-Staging';
const proposal=()=>proposeTask({requestId:'main17485test01',task:'git-status',workspace,now:1000});
const allow=p=>({approved:true,localGesture:true,requestId:p.payload.requestId,sha256:p.sha256});
test('exact one-shot intent is expressed in fixed executable/arguments',()=>{
 const p=proposal(), verified=verifyApprovedTask(p,allow(p),{now:1200});
 assert.equal(verified.exe,'git.exe');
 assert.deepEqual(verified.argv,['status','--short','--branch']);
});
test('missing local consent fails closed',()=>{
 const p=proposal();
 for(const a of [null,{...allow(p),approved:false},{...allow(p),localGesture:false},{...allow(p),sha256:'deadbeef'}])
  assert.throws(()=>verifyApprovedTask(p,a,{now:1200}));
});
test('approval is pinned to exact payload and expires',()=>{
 const p=proposal();
 assert.throws(()=>verifyApprovedTask(p,allow(p),{now:91000}),/APPROVAL_EXPIRED/);
 assert.throws(()=>verifyApprovedTask({...p,payload:{...p.payload,argv:['status','--porcelain']}},allow(p),{now:1200}),/PROPOSAL_CHANGED/);
});
test('arbitrary shell and unsafe paths are not proposal tasks',()=>{
 for(const task of ['powershell','cmd','iex','git-reset','invoke-expression','dotnet-build'])
  assert.throws(()=>proposeTask({requestId:'main17485test01',task,workspace,now:1000}),/TASK_NOT_ALLOWED/);
 for(const unsafe of ['C:\\Windows\\System32','..\\escape','\\\\server\\share','C:\\Program Files\\App'])
  assert.throws(()=>proposeTask({requestId:'main17485test01',task:'git-status',workspace:unsafe,now:1000}));
});
test('request IDs are mandatory and bounded',()=>{
 assert.throws(()=>proposeTask({requestId:'x',task:'git-status',workspace}),/INVALID_REQUEST_ID/);
});
