import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PowerShellApprovalService} from '../service.mjs';
import {resolveEngineeringPlan,verifyEngineeringPlan} from '../../ai_collaboration/engineering-plan.mjs';

async function fixture(fn){
  const root=await mkdtemp(path.join(tmpdir(),'psdirect-eng-'));
  await mkdir(path.join(root,'tests'));
  await writeFile(path.join(root,'tests','safe.test.mjs'),"// synthetic test\n");
  await writeFile(path.join(root,'demo.csproj'),'<Project></Project>');
  let starts=0;
  const svc=new PowerShellApprovalService({
    root:'C:\\Engineering',port:0,engineeringWorkspaceRoots:[root],
    engineeringAuditDirectory:path.join(root,'audit'),
    engineeringRunner:async()=>{starts++;return {
      exitCode:0,state:'FINISHED',stdout:'PASS',stderr:'',truncated:false
    }}
  });
  await svc.start();
  try{await fn({root,svc,starts:()=>starts});}
  finally{await svc.stop();await rm(root,{recursive:true,force:true});}
}
const rpc=(svc,name,args)=>svc.rpc({jsonrpc:'2.0',id:1,
  method:'tools/call',params:{name,arguments:args}});
const req=(root,id,operation='git-status')=>({
  requestId:id,operation,workspace:root
});
async function pending(svc,id){
  for(let i=0;i<100;i++){
    const p=svc.namedPending.get(id);
    if(p)return p;
    await new Promise(r=>setTimeout(r,10));
  }
  throw Error('PENDING_TIMEOUT');
}
const approve=async(svc,p,approved)=>fetch('http://127.0.0.1:'+svc.port+'/decide?key='+svc.uiToken,{
  method:'POST',headers:{Origin:'http://127.0.0.1:'+svc.port},
  body:new URLSearchParams({kind:'named',id:p.requestId,sha256:p.planSha256,
    approved:approved?'yes':'no'})
});
async function status(svc,id){
  // Concurrent Windows audit-file readers can delay a final atomic rename.
  // Use a real deadline and report the observed state instead of an opaque timeout.
  const until=Date.now()+5000;
  let last=null;
  do{
    last=await svc.engineeringService.status(id);
    if(['DENIED','FINISHED','FAILED','UNKNOWN_OR_FAILED','TIMED_OUT'].includes(last.state))
      return last;
    await new Promise(r=>setTimeout(r,20));
  }while(Date.now()<until);
  throw Error('FINAL_TIMEOUT lastState='+String(last?.state));
}
test('feature is opt-in and does not replace five read-only diagnostics',()=>fixture(async({svc})=>{
  const names=svc.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools.map(x=>x.name);
  assert.ok(names.includes('powershell_engineering_submit'));
  assert.ok(names.includes('powershell_engineering_status'));
  assert.ok(names.includes('powershell_propose'));
  assert.ok(!names.includes('powershell_execute_arbitrary'));
}));
test('engineering DENY never executes',()=>fixture(async({svc,root,starts})=>{
  const id='eng-deny-0001';
  const queued=rpc(svc,'powershell_engineering_submit',req(root,id));
  assert.equal(JSON.parse(queued.result.content[0].text).state,'QUEUED_FOR_LOCAL_APPROVAL');
  const p=await pending(svc,id);
  const page=await fetch('http://127.0.0.1:'+svc.port+'/approve?key='+svc.uiToken);
  assert.match(await page.text(),/git-status/);
  assert.equal((await approve(svc,p,false)).status,200);
  const denied=await status(svc,id);
  assert.equal(denied.state,'DENIED');
  assert.equal(denied.reason,'OPERATOR_DENIED');
  assert.equal(starts(),0);
}));
test('engineering ALLOW runs once, no replay',()=>fixture(async({svc,root,starts})=>{
  const id='eng-allow-0002';
  rpc(svc,'powershell_engineering_submit',req(root,id,'git-diff'));
  const p=await pending(svc,id);
  const decision=await approve(svc,p,true);
  assert.equal(decision.status,200);
  assert.equal((await decision.json()).state,'APPROVED_RECORDED');
  assert.equal((await status(svc,id)).state,'FINISHED');
  assert.equal(starts(),1);
  rpc(svc,'powershell_engineering_submit',req(root,id,'git-diff'));
  await new Promise(r=>setTimeout(r,30));
  assert.equal(starts(),1);
}));
test('arbitrary PowerShell and approval injection rejected before queue',()=>fixture(async({svc,root})=>{
  for(const args of [
    {...req(root,'eng-inject-003'),approved:true},
    {...req(root,'eng-inject-004'),operation:'powershell -Command rm'},
    {...req(root,'eng-inject-005'),target:'..\\config.json',operation:'node-test'},
    {...req(root,'eng-inject-006'),pid:0,operation:'process-inspect'}
  ]){
    const r=rpc(svc,'powershell_engineering_submit',args);
    assert.equal(r.result.isError,true);
  }
  assert.equal(svc.namedPending.size,0);
}));
test('a single real test file inside the workspace can be planned',()=>fixture(async({root})=>{
  const plan=await resolveEngineeringPlan({
    ...req(root,'eng-plan-0007','node-test'),target:'tests/safe.test.mjs'
  },[root]);
  assert.equal(plan.args[0],'--test');
  assert.equal(plan.risk,'code-execution');
  assert.equal(verifyEngineeringPlan(plan),plan);
}));
test('unknown workspace is rejected by the policy',()=>fixture(async({root})=>{
  await assert.rejects(resolveEngineeringPlan(req(root,'eng-plan-0008'),[tmpdir()]),
    /WORKSPACE_NOT_ALLOWLISTED/);
}));
test('read-only process and port diagnostics cannot receive free-form script',()=>fixture(async({root})=>{
  const processPlan=await resolveEngineeringPlan({...req(root,'eng-plan-0009','process-inspect'),pid:4321},[root]);
  assert.match(processPlan.args.at(-1),/ProcessId=\$id/);
  const portPlan=await resolveEngineeringPlan({...req(root,'eng-plan-0010','port-inspect'),port:17486},[root]);
  assert.match(portPlan.args.at(-1),/17486/);
}));

test('approved PowerShell diagnostic script binds script path and digest',()=>fixture(async({root})=>{
  const diag=path.join(root,'tests','check.ps1');
  await writeFile(diag,"Write-Output 'OK'");
  const plan=await resolveEngineeringPlan({
    ...req(root,'eng-script-001','powershell-script'),
    target:'tests/check.ps1',scriptArgs:['-Mode','Status']
  },[root]);
  assert.equal(plan.risk,'code-execution');
  assert.ok(plan.args.includes('-File'));
  assert.equal(plan.args.at(-2),'-Mode');
  assert.equal(plan.sourceSha256.length,64);
}));
test('script arguments reject hidden newline and command text through MCP',()=>fixture(async({root,svc})=>{
  const r=rpc(svc,'powershell_engineering_submit',{
    ...req(root,'eng-script-002','powershell-script'),
    target:'tests/check.ps1',scriptArgs:['-Mode', "Status\nRemove-Item C:"]
  });
  assert.equal(r.result.isError,true);
  assert.equal(svc.namedPending.size,0);
}));
test('modified test path inside workspace remains a pinned file',()=>fixture(async({root})=>{
  const plan=await resolveEngineeringPlan({
    ...req(root,'eng-script-003','node-script'),target:'tests/safe.test.mjs',
    scriptArgs:['--version']
  },[root]);
  assert.equal(plan.args[0],path.join(root,'tests','safe.test.mjs'));
  assert.equal(plan.sourceSha256.length,64);
}));

test('approval expiry is distinct from an explicit operator Deny',()=>fixture(async({svc,root,starts})=>{
  const id='eng-expired-0001';
  rpc(svc,'powershell_engineering_submit',req(root,id));
  const p=await pending(svc,id);
  clearTimeout(p.timer);
  svc.namedPending.delete(id);
  p.resolve({approved:false,reason:'APPROVAL_EXPIRED',requestId:id,
    planSha256:p.planSha256});
  const final=await status(svc,id);
  assert.equal(final.state,'DENIED');
  assert.equal(final.reason,'APPROVAL_EXPIRED');
  assert.equal(starts(),0);
}));

test('status polling during audit transitions never receives truncated JSON',()=>fixture(async({svc,root})=>{
  const id='eng-audit-race-0001';
  rpc(svc,'powershell_engineering_submit',req(root,id,'git-status'));
  const pendingEntry=await pending(svc,id);
  const reads=[];
  for(let j=0;j<120;j++){
    reads.push(svc.engineeringService.status(id));
  }
  const decision=await approve(svc,pendingEntry,true);
  assert.equal(decision.status,200);
  for(let j=0;j<120;j++){
    reads.push(svc.engineeringService.status(id));
  }
  const results=await Promise.all(reads);
  for(const state of results){
    assert.equal(state.requestId,id);
    assert.ok(['CLAIM_IN_PROGRESS','PENDING_LOCAL_APPROVAL','RUNNING','FINISHED'].includes(state.state),state.state);
  }
  assert.equal((await status(svc,id)).state,'FINISHED');
}));

test('new fixed Git operations appear in MCP schema without arbitrary refspecs',()=>fixture(async({svc,root,starts})=>{
 const item=svc.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools
  .find(x=>x.name==='powershell_engineering_submit');
 for(const op of ['git-branch','git-diff-check','git-pull-ff-only']){
  assert.ok(item.inputSchema.properties.operation.enum.includes(op));
 }
 for(const injected of [
  {...req(root,'git-pull-bad-01','git-pull-ff-only'),target:'origin/main'},
  {...req(root,'git-pull-bad-02','git-pull-ff-only'),scriptArgs:['--force']},
  {...req(root,'git-pull-bad-03','git-pull-ff-only'),approved:true},
  {...req(root,'git-pull-bad-04','git-pull-ff-only'),port:17486},
  {...req(root,'git-pull-bad-05','git-pull-ff-only'),operation:'git-reset'}
 ]){
  const response=rpc(svc,'powershell_engineering_submit',injected);
  assert.equal(response.result.isError,true);
 }
 assert.equal(starts(),0);
 assert.equal(svc.namedPending.size,0);
 const plan=await resolveEngineeringPlan(req(root,'git-pull-plan-01','git-pull-ff-only'),[root]);
 assert.equal(plan.risk,'workspace-write');
 assert.ok(plan.args.includes('--ff-only'));
 assert.ok(!plan.args.includes('--force'));
}));
