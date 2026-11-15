// True loopback HTTP + real Windows git execution in an isolated RC1 service.
// This script is run locally by the operator, and never binds production 17486.
// Approval is deliberately simulated ONLY for one read-only git-status in this
// ephemeral test service; it is NOT proof of human approval UX in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PowerShellApprovalService} from './service.mjs';
const root=path.win32.normalize('C:\\Engineering');
const lab='C:\\Engineering\\PowerShellDirect-Release-RC1-Lab';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const read=async(svc,method,params={},id=1)=>{
 const response=await fetch('http://127.0.0.1:'+svc.port+'/mcp',{
  method:'POST',headers:{'Authorization':'Bearer '+svc.agentToken,'Content-Type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id,method,params})
 });
 assert.equal(response.status,200);
 return response.json();
};
const call=async(svc,name,args)=>{
 const value=await read(svc,'tools/call',{name,arguments:args});
 assert.ok(value.result && value.result.content);
 if(value.result.isError)throw Error(value.result.content[0].text);
 return JSON.parse(value.result.content[0].text);
};
const status=(svc,id)=>call(svc,'powershell_engineering_status',{requestId:id});
async function until(fn){
 for(let i=0;i<80;i++){const found=await fn();if(found)return found;await pause(25);}
 throw Error('LIVE_E2E_TIMEOUT');
}
async function decide(svc,id,approved){
 const entry=await until(()=>svc.namedPending.get(id));
 const response=await fetch('http://127.0.0.1:'+svc.port+'/decide?key='+svc.uiToken,{
  method:'POST',
  headers:{Origin:'http://127.0.0.1:'+svc.port},
  body:new URLSearchParams({kind:'named',id,sha256:entry.planSha256,
    approved:approved?'yes':'no'})
 });
 assert.equal(response.status,200);
 return response.json();
}
const create=(audit)=>new PowerShellApprovalService({
 root,port:0,chatReadonlyEnabled:false,
 engineeringWorkspaceRoots:[lab],engineeringAuditDirectory:audit
});
test('RC1 loopback HTTP and real Windows git-status: approval, denial, replay, restart',async()=>{
 if(process.platform!=='win32')throw Error('WINDOWS_ONLY_LIVE_E2E');
 const audit=await mkdtemp(path.join(tmpdir(),'engineering-rc1-live-e2e-'));
 let svc=create(audit);
 let stopped=false;
 try{
  await svc.start();
  assert.notEqual(svc.port,17486);
  assert.notEqual(svc.port,18086);
  const base='http://127.0.0.1:'+svc.port;
  let r=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal(r.status,401);
  const listing=await read(svc,'tools/list');
  assert.ok(listing.result.tools.some(t=>t.name==='powershell_engineering_submit'));
  const id='rc1-live-allow-20261115';
  const submitted=await call(svc,'powershell_engineering_submit',{
   requestId:id,operation:'git-status',workspace:lab
  });
  assert.equal(submitted.state,'QUEUED_FOR_LOCAL_APPROVAL');
  const pending=await until(async()=>{
   const x=await status(svc,id);return x.state==='PENDING_LOCAL_APPROVAL'?x:null;
  });
  assert.equal(pending.state,'PENDING_LOCAL_APPROVAL');
  await decide(svc,id,true);
  const finished=await until(async()=>{
   const x=await status(svc,id);return x.state==='FINISHED'||x.state==='FAILED'?x:null;
  });
  assert.equal(finished.state,'FINISHED',JSON.stringify(finished));
  assert.equal(finished.exitCode,0);
  assert.match(finished.stdout,/release\\/engineering-mcp-rc1-20261115/);
  const again=await call(svc,'powershell_engineering_submit',{
   requestId:id,operation:'git-status',workspace:lab
  });
  assert.equal(again.state,'QUEUED_FOR_LOCAL_APPROVAL');
  await pause(60);
  assert.equal((await status(svc,id)).state,'FINISHED');
  const deniedId='rc1-live-deny-20261115';
  await call(svc,'powershell_engineering_submit',{
   requestId:deniedId,operation:'git-status',workspace:lab
  });
  await decide(svc,deniedId,false);
  const denied=await until(async()=>{
   const x=await status(svc,deniedId);return x.state==='DENIED'?x:null;
  });
  assert.equal(denied.reason,'OPERATOR_DENIED');
  assert.equal(denied.exitCode,undefined);
  const blocked=await call(svc,'powershell_engineering_submit',{
   requestId:'rc1-live-block-20261115',operation:'git-status',
   workspace:'C:\\Windows'
  });
  assert.equal(blocked.state,'QUEUED_FOR_LOCAL_APPROVAL');
  const blockedStatus=await until(async()=>{
   const x=await status(svc,'rc1-live-block-20261115');
   return x.state==='UNKNOWN_OR_FAILED'?x:null;
  });
  assert.equal(blockedStatus.errorCode,'WORKSPACE_NOT_ALLOWLISTED');
  await svc.stop();stopped=true;
  svc=create(audit);await svc.start();stopped=false;
  assert.equal((await status(svc,id)).state,'FINISHED');
  assert.equal((await status(svc,deniedId)).state,'DENIED');
  console.log('RC1_LIVE_E2E_PASS: HTTP MCP, real Windows git-status, deny, replay, workspace policy, durable restart; production untouched');
 }finally{
  if(!stopped)await svc.stop().catch(()=>{});
  await rm(audit,{recursive:true,force:true,maxRetries:20,retryDelay:50});
 }
});
