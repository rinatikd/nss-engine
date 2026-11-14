import test from 'node:test';
import assert from 'node:assert/strict';
import {PowerShellApprovalService} from '../service.mjs';
import {POLICY,validateTask} from '../runner.mjs';

const root='C:\\Engineering';
function service(run=async()=>({state:'FINISHED',exitCode:0,stdout:'main',stderr:''})){
 return new PowerShellApprovalService({
  root,port:0,chatReadonlyEnabled:true,
  workspaceCheck:()=> 'C:\\Engineering\\Repo',run
 });
}
const schema=svc=>svc.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools
 .find(x=>x.name==='powershell_chat_readonly').inputSchema;

test('chat approval path exposes exact fixed git-branch and git-log without shell text',()=>{
 const svc=service();
 for(const op of ['git-branch','git-log']){
  assert.ok(schema(svc).properties.task.enum.includes(op));
  assert.equal(validateTask(op),POLICY[op]);
  assert.equal(POLICY[op].exe,'git.exe');
  assert.ok(POLICY[op].args.includes('--no-pager'));
  assert.ok(POLICY[op].args.includes('core.hooksPath=NUL'));
  assert.ok(!POLICY[op].args.includes('--force'));
 }
 assert.equal(schema(svc).additionalProperties,false);
 assert.equal(schema(svc).properties.task.enum.includes('git-pull-ff-only'),false);
 assert.equal(schema(svc).properties.task.enum.includes('powershell-script'),false);
});

test('chat readonly runs pinned git-branch once with host tool gate, no local page',async()=>{
 let count=0;
 const svc=service(async()=>{count++;return {state:'FINISHED',exitCode:0,stdout:'main'}});
 const id='chat-branch-001';
 const accepted=svc.chatReadonly({requestId:id,task:'git-branch',workspace:'C:\\Engineering\\Repo'});
 assert.equal(accepted.state,'RUNNING');
 assert.equal(svc.namedPending.size,0);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(svc.status(id).state,'FINISHED');
 assert.equal(count,1);
 assert.throws(()=>svc.chatReadonly({requestId:id,task:'git-branch',workspace:'C:\\Engineering\\Repo'}),/DUPLICATE_REQUEST_ID/);
 assert.equal(count,1);
});

test('chat diagnostic forbids arbitrary shell, git pull and injected approval',()=>{
 const svc=service();
 for(const task of ['git-pull-ff-only','git push','powershell-script','git reset --hard']){
  assert.throws(()=>svc.chatReadonly({requestId:'chat-reject-001',task,workspace:'C:\\Engineering\\Repo'}),/TASK_NOT_ALLOWED/);
 }
 assert.equal(svc.namedPending.size,0);
});
