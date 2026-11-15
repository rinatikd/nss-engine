import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PowerShellApprovalService} from '../service.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(fn) {
  const dir=await mkdtemp(path.join(tmpdir(),'psdirect-named-'));
  let starts=0;
  const svc=new PowerShellApprovalService({
    root:'C:\\Engineering',port:0,namedWorkspaceRoots:[dir],
    namedAuditDirectory:path.join(dir,'audits'),
    namedRunner:async()=>{starts++;return {
      exitCode:0,stdout:'PASS',stderr:'',truncated:false
    }}
  });
  await svc.start();
  try{await fn({svc,dir,starts:()=>starts});}
  finally{await svc.stop();await rm(dir,{recursive:true,force:true});}
}
const req=(workspace,id)=>({
  requestId:id,suite:'chrome-pr113-node',workspace
});
const rpc=(svc,name,args)=>svc.rpc({jsonrpc:'2.0',id:1,
  method:'tools/call',params:{name,arguments:args}});
async function waitFor(fn,ms=1200){
  const until=Date.now()+ms;
  while(Date.now()<until){
    const x=await fn();
    if(x)return x;
    await new Promise(resolve=>setTimeout(resolve,15));
  }
  throw Error('CONDITION_NOT_REACHED');
}
const approval=async(svc,entry,approved)=>{
  const port=svc.port;
  const response=await fetch('http://127.0.0.1:'+port+'/decide?key='+svc.uiToken,{
    method:'POST',headers:{Origin:'http://127.0.0.1:'+port},
    body:new URLSearchParams({
      kind:'named',id:entry.requestId,sha256:entry.planSha256,
      approved:approved?'yes':'no'
    })
  });
  return response;
};

test('named tools are registered only in explicitly opted-in service',()=>fixture(async({svc})=>{
  const list=svc.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools.map(x=>x.name);
  assert.ok(list.includes('powershell_named_suite_submit'));
  assert.ok(list.includes('powershell_named_suite_status'));
  assert.ok(!list.includes('powershell_execute_approved'));
}));

test('local denial blocks named-suite execution',()=>fixture(async({svc,dir,starts})=>{
  const id='named-denial-001';
  const res=rpc(svc,'powershell_named_suite_submit',req(dir,id));
  assert.equal(JSON.parse(res.result.content[0].text).state,'QUEUED_FOR_LOCAL_APPROVAL');
  const entry=await waitFor(()=>svc.namedPending.get(id));
  const page=await fetch('http://127.0.0.1:'+svc.port+'/approve?key='+svc.uiToken);
  assert.match(await page.text(),/Named suite/);
  assert.equal((await approval(svc,entry,false)).status,200);
  await waitFor(async()=>(await svc.namedService.status(id)).state==='DENIED');
  assert.equal(starts(),0);
}));

test('local approval runs once; same requestId cannot replay',()=>fixture(async({svc,dir,starts})=>{
  const id='named-approve-001';
  rpc(svc,'powershell_named_suite_submit',req(dir,id));
  const entry=await waitFor(()=>svc.namedPending.get(id));
  const bad=await fetch('http://127.0.0.1:'+svc.port+'/decide?key='+svc.uiToken,{
    method:'POST',headers:{Origin:'http://127.0.0.1:'+svc.port},
    body:new URLSearchParams({
      kind:'named',id,sha256:'tampered',approved:'yes'
    })
  });
  assert.equal(bad.status,400);
  assert.equal(starts(),0);
  assert.equal((await approval(svc,entry,true)).status,200);
  await waitFor(async()=>(await svc.namedService.status(id)).state==='FINISHED');
  assert.equal(starts(),1);
  rpc(svc,'powershell_named_suite_submit',req(dir,id));
  await flush();
  assert.equal(starts(),1);
}));

test('named job STATUS does not start a pending job',()=>fixture(async({svc,dir,starts})=>{
  const id='named-status-001';
  rpc(svc,'powershell_named_suite_submit',req(dir,id));
  await waitFor(()=>svc.namedPending.get(id));
  const response=await rpc(svc,'powershell_named_suite_status',{requestId:id});
  const status=JSON.parse(response.result.content[0].text);
  assert.equal(status.state,'PENDING_LOCAL_APPROVAL');
  assert.equal(starts(),0);
  const entry=svc.namedPending.get(id);
  assert.equal((await approval(svc,entry,false)).status,200);
  // Approval HTTP response precedes the async durable DENIED audit write.
  // Do not remove the fixture directory until the background job completes.
  await waitFor(async()=>{
    const job=await svc.namedService.status(id);
    return job.state==='DENIED'?job:null;
  });
  assert.equal(starts(),0);
}));

test('model cannot smuggle approval=true',()=>fixture(async({svc,dir,starts})=>{
  const res=rpc(svc,'powershell_named_suite_submit',{
    ...req(dir,'named-inject-001'),approved:true
  });
  assert.equal(res.result.isError,true);
  assert.match(res.result.content[0].text,/INVALID_TOOL_ARGUMENTS/);
  await flush();
  assert.equal(svc.namedPending.size,0);
  assert.equal(starts(),0);
}));
