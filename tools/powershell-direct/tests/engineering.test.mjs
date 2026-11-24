import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
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
    port:0,engineeringAuditDirectory:path.join(root,'audit'),
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
    approved:approved?'yes':'no'}),redirect:'manual'
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
test('production cutover remains hard-disabled until graceful drain, journal and rollback exist',async()=>{
  const script=await readFile(new URL('../Invoke-EngineeringCutover.ps1',import.meta.url),'utf8');
  const guard=script.indexOf("throw 'CUTOVER_DISABLED_GRACEFUL_DRAIN_JOURNAL_ROLLBACK_REQUIRED'");
  const forceStop=script.indexOf('Stop-ExactStack $oldStack');
  assert.ok(guard>=0,'unconditional Cutover NO-GO guard is present');
  assert.ok(forceStop>guard,'NO-GO guard precedes any production stack stop');
});

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
  assert.equal(JSON.parse(queued.result.content[0].text).state,'SUBMISSION_RECEIVED_STATUS_UNCONFIRMED');
  const p=await pending(svc,id);
  const page=await fetch('http://127.0.0.1:'+svc.port+'/approve?key='+svc.uiToken);
  assert.match(await page.text(),/git-status/);
  assert.equal((await approve(svc,p,false)).status,303);
  const denied=await status(svc,id);
  assert.equal(denied.state,'DENIED');
  assert.equal(denied.reason,'OPERATOR_DENIED');
  assert.equal(starts(),0);
}));
test('service stop denies pending approval immediately and clears its timer',()=>fixture(async({svc,root,starts})=>{
  const id='eng-stop-0001';
  rpc(svc,'powershell_engineering_submit',req(root,id));
  await pending(svc,id);
  await svc.stop();
  const denied=await svc.engineeringService.status(id);
  assert.equal(denied.state,'DENIED');
  assert.equal(denied.reason,'SERVICE_STOPPED');
  assert.equal(svc.namedPending.size,0);
  assert.equal(starts(),0);
  const afterStop=rpc(svc,'powershell_engineering_submit',req(root,'eng-stop-late-01'));
  assert.equal(afterStop.result.isError,true);
  assert.equal(afterStop.result.content[0].text,'SERVICE_STOPPING');
}));

test('service stop waits for an approved runner and final audit publication',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'psdirect-drain-'));
  let markStarted,releaseRunner;
  const started=new Promise(resolve=>{markStarted=resolve;});
  const svc=new PowerShellApprovalService({
    port:0,engineeringAuditDirectory:path.join(root,'audit'),
    engineeringRunner:async()=>{
      markStarted();
      await new Promise(resolve=>{releaseRunner=resolve;});
      return {exitCode:0,state:'FINISHED',stdout:'DRAINED',stderr:'',truncated:false};
    }
  });
  await svc.start();
  try{
    const id='eng-drain-0001';
    rpc(svc,'powershell_engineering_submit',req(root,id));
    const approval=await pending(svc,id);
    assert.equal((await approve(svc,approval,true)).status,303);
    await started;
    let stopResolved=false;
    const stop=svc.stop().then(result=>{stopResolved=true;return result;});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(stopResolved,false,'stop must wait for active runner completion');
    releaseRunner();
    const drained=await stop;
    assert.equal(drained.drained,true);
    assert.equal(drained.backgroundJobsRemaining,0);
    const final=await svc.engineeringService.status(id);
    assert.equal(final.state,'FINISHED');
    assert.equal(final.stdout,'DRAINED');
  }finally{
    if(!svc.stopping)await svc.stop();
    await rm(root,{recursive:true,force:true});
  }
});

test('engineering ALLOW runs once, no replay',()=>fixture(async({svc,root,starts})=>{
  const id='eng-allow-0002';
  rpc(svc,'powershell_engineering_submit',req(root,id,'git-diff'));
  const p=await pending(svc,id);
  const decision=await approve(svc,p,true);
  assert.equal(decision.status,303);
  assert.equal((await status(svc,id)).state,'FINISHED');
  assert.equal(starts(),1);
  const replay=rpc(svc,'powershell_engineering_submit',req(root,id,'git-diff'));
  assert.equal(JSON.parse(replay.result.content[0].text).state,
    'SUBMISSION_RECEIVED_STATUS_UNCONFIRMED');
  await new Promise(r=>setTimeout(r,30));
  assert.equal(starts(),1);
  assert.equal((await status(svc,id)).state,'FINISHED');
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
  });
  assert.equal(plan.args[0],'--test');
  assert.equal(plan.risk,'code-execution');
  assert.equal(verifyEngineeringPlan(plan),plan);
}));
test('any existing user-selected workspace is accepted per job without a static folder list',()=>fixture(async()=>{
  const other=await mkdtemp(path.join(tmpdir(),'psdirect-other-'));
  try{
    const plan=await resolveEngineeringPlan(req(other,'eng-plan-0008'));
    assert.equal(plan.cwd,other);
    assert.equal(plan.risk,'read');
  }finally{await rm(other,{recursive:true,force:true});}
}));
test('read-only process and port diagnostics cannot receive free-form script',()=>fixture(async({root})=>{
  const processPlan=await resolveEngineeringPlan({...req(root,'eng-plan-0009','process-inspect'),pid:4321});
  assert.match(processPlan.args.at(-1),/ProcessId=\$id/);
  const portPlan=await resolveEngineeringPlan({...req(root,'eng-plan-0010','port-inspect'),port:17486});
  assert.match(portPlan.args.at(-1),/17486/);
}));

test('approved PowerShell diagnostic script binds script path and digest',()=>fixture(async({root})=>{
  const diag=path.join(root,'tests','check.ps1');
  await writeFile(diag,"Write-Output 'OK'");
  const plan=await resolveEngineeringPlan({
    ...req(root,'eng-script-001','powershell-script'),
    target:'tests/check.ps1',scriptArgs:['-Mode','Status']
  });
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
  });
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
  assert.equal(decision.status,303);
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

test('engineering recent MCP lists durable outcomes without command replay',()=>fixture(async({svc,root,starts})=>{
 const id='engineering-recent-01';
 const initially=await rpc(svc,'powershell_engineering_recent',{limit:10});
 assert.deepEqual(JSON.parse(initially.result.content[0].text),[]);
 rpc(svc,'powershell_engineering_submit',req(root,id,'git-status'));
 const entry=await pending(svc,id);
 const decision=await approve(svc,entry,false);
 assert.equal(decision.status,303);
 assert.equal((await status(svc,id)).state,'DENIED');
 const audit=await rpc(svc,'powershell_engineering_recent',{limit:10});
 const items=JSON.parse(audit.result.content[0].text);
 assert.equal(items.length,1);
 assert.equal(items[0].requestId,id);
 assert.equal(items[0].state,'DENIED');
 assert.equal('command' in items[0],false);
 assert.equal('stdout' in items[0],false);
 assert.equal(starts(),0);
 const invalid=await rpc(svc,'powershell_engineering_recent',{limit:500});
 assert.equal(invalid.result.isError,true);
}));
