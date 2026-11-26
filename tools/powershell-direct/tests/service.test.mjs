import test from 'node:test';
import assert from 'node:assert/strict';
import {PowerShellApprovalService} from '../service.mjs';
import {createApprovalProxy} from '../approval-proxy.mjs';

const workspace='C:\\Engineering\\NSS_Engine';
function fixture(){
 let time=1000,executed=0,release;
 const service=new PowerShellApprovalService({
  root:'C:\\Engineering',port:0,now:()=>time,
  workspaceCheck:(candidate,root)=>{
   if(root!=='C:\\Engineering'||candidate!==workspace)throw Error('WORKSPACE_DENIED');
   return candidate;
  },
  run:async ({task,workspace:cwd})=>{
   executed++;
   assert.equal(task,'git-status');assert.equal(cwd,workspace);
   return await new Promise(resolve=>release=()=>resolve({state:'FINISHED',exitCode:0,stdout:'OK',stderr:''}));
  }
 });
 return {service,advance:n=>time+=n,executed:()=>executed,finish:()=>release?.()};
}
const req={requestId:'approvedcmd01',task:'git-status',workspace};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('no execution before explicit local approval; denial never invokes runner',()=>{
 const x=fixture(),p=x.service.propose(req);
 assert.equal(p.state,'PENDING');assert.equal(x.executed(),0);
 assert.deepEqual(x.service.decide(req.requestId,p.sha256,false),{state:'DENIED'});
 assert.equal(x.executed(),0);
 assert.throws(()=>x.service.decide(req.requestId,p.sha256,true),/NOT_PENDING/);
});
test('approved task runs once, then returns result without duplicate execution',async()=>{
 const x=fixture(),p=x.service.propose(req);
 assert.throws(()=>x.service.decide(req.requestId,'0000',true),/HASH_MISMATCH/);
 assert.equal(x.service.decide(req.requestId,p.sha256,true).state,'RUNNING');
 assert.equal(x.executed(),1);
 assert.throws(()=>x.service.decide(req.requestId,p.sha256,true),/NOT_PENDING/);
 x.finish();await flush();
 assert.equal(x.service.status(req.requestId).result.stdout,'OK');
 assert.equal(x.executed(),1);
});
test('expiry and duplicate request IDs are fail closed',()=>{
 const x=fixture(),p=x.service.propose(req);
 assert.throws(()=>x.service.propose(req),/DUPLICATE_REQUEST_ID/);
 x.advance(90000);
 assert.equal(x.service.status(req.requestId).state,'EXPIRED');
 assert.throws(()=>x.service.decide(req.requestId,p.sha256,true),/NOT_PENDING/);
 assert.equal(x.executed(),0);
});
test('no arbitrary shell command, expanded diagnostic task, or unapproved workspace',()=>{
 const x=fixture();
 for(const task of ['pwsh','powershell','cmd','git-reset','node-eval','dotnet-build','chrome-bridge-ports','chrome-bridge-sessions','tunnel-client-pids'])
  assert.throws(()=>x.service.propose({...req,requestId:'rejectedtask01',task}),/TASK_NOT_ALLOWED/);
 assert.throws(()=>x.service.propose({...req,workspace:'C:\\Windows\\System32'}),/WORKSPACE_DENIED/);
});
test('server-side allowlist and MCP tool surface stay fixed at three tools',()=>{
 const x=fixture();
 const tools=x.service.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools;
 assert.deepEqual(tools.map(t=>t.name),['powershell_propose','powershell_cancel','powershell_job']);
 assert.deepEqual(tools[0].inputSchema.properties.task.enum,
  ['git-status','git-diff-check','dotnet-version','node-version','powershell-version']);
 const p=x.service.rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'powershell_propose',arguments:req}});
 assert.equal(p.result.isError,undefined);
 assert.equal(x.executed(),0);
 for(const name of ['powershell_execute_approved','powershell_chat_readonly','powershell_diagnostics']){
  const denied=x.service.rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:req}});
  assert.equal(denied.result.isError,true);
 }
 assert.equal(x.executed(),0);
});
test('local approval is authenticated by bearer header; no token in URL or page',async()=>{
 const x=fixture();await x.service.start();
 try{
  const p=x.service.propose(req),base='http://127.0.0.1:'+x.service.port;
  const denied=await fetch(base+'/approve');
  assert.equal(denied.status,403);
  const approvalPage=await fetch(base+'/approve',{headers:{Authorization:'Bearer '+x.service.uiToken}});
  assert.equal(approvalPage.status,200);
  assert.equal(approvalPage.headers.get('referrer-policy'),'no-referrer');
  const html=await approvalPage.text();
  assert.match(html,/Approve once/);
  assert.doesNotMatch(html,new RegExp(x.service.uiToken));
  assert.doesNotMatch(approvalPage.url,/key=/);
  const body=new URLSearchParams({id:req.requestId,sha256:p.sha256,approved:'yes'});
  const badOrigin=await fetch(base+'/decide',{method:'POST',headers:{Authorization:'Bearer '+x.service.uiToken,Origin:'null'},body});
  assert.equal(badOrigin.status,403);assert.equal(x.executed(),0);
 }finally{await x.service.stop();}
});
test('ephemeral approval proxy never exposes UI token and enforces same-origin POST',async()=>{
 const x=fixture();await x.service.start();
 const nonce='a'.repeat(64);
 const proxy=createApprovalProxy({servicePort:x.service.port,uiToken:x.service.uiToken,nonce});
 const opened=await proxy.start();
 try{
  const p=x.service.propose(req);
  const page=await fetch(opened.url);
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Approve once/);
  assert.doesNotMatch(html,new RegExp(x.service.uiToken));
  assert.doesNotMatch(opened.url,new RegExp(x.service.uiToken));
  assert.match(opened.url,new RegExp(nonce));
  const body=new URLSearchParams({id:req.requestId,sha256:p.sha256,approved:'yes'});
  const origin='http://127.0.0.1:'+opened.port;
  const rejected=await fetch(origin+'/'+nonce+'/decide',{method:'POST',headers:{Origin:'null'},body});
  assert.equal(rejected.status,403);assert.equal(x.executed(),0);
  const accepted=await fetch(origin+'/'+nonce+'/decide',{method:'POST',headers:{Origin:origin},body});
  assert.equal(accepted.status,200);
  assert.equal(x.executed(),1);
  x.finish();await flush();
  const stale=await fetch(origin+'/wrong/approve');
  assert.equal(stale.status,404);
 }finally{await proxy.stop();await x.service.stop();}
});
test('MCP cancellation does not start a command and cannot be reversed',()=>{
 const x=fixture(),p=x.service.propose(req);
 const cancelled=x.service.rpc({jsonrpc:'2.0',id:5,method:'tools/call',
  params:{name:'powershell_cancel',arguments:{requestId:req.requestId}}});
 assert.equal(JSON.parse(cancelled.result.content[0].text).state,'CANCELLED');
 assert.equal(x.executed(),0);
 assert.throws(()=>x.service.decide(req.requestId,p.sha256,true),/NOT_PENDING/);
});
test('MCP endpoint refuses missing/incorrect token, then returns only the safe toolset',async()=>{
 const x=fixture();await x.service.start();
 try{
  const url='http://127.0.0.1:'+x.service.port+'/mcp', request={jsonrpc:'2.0',id:1,method:'tools/list'};
  const denied=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
  assert.equal(denied.status,401);
  const allowed=await fetch(url,{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+x.service.agentToken},body:JSON.stringify(request)});
  assert.equal(allowed.status,200);
  const list=(await allowed.json()).result.tools.map(x=>x.name);
  assert.deepEqual(list,['powershell_propose','powershell_cancel','powershell_job']);
  assert.equal(x.executed(),0);
 }finally{await x.service.stop();}
});
