import test from 'node:test';
import assert from 'node:assert/strict';
import {PowerShellApprovalService} from '../service.mjs';

const workspace='C:\\Engineering\\NSS_Engine';
function fixture(){
 let time=1000,executed=0,release;
 const service=new PowerShellApprovalService({
  root:'C:\\Engineering',now:()=>time,
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

test('no execution before explicit local approval; denial never invokes runner',async()=>{
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
test('no arbitrary shell command or unapproved workspace',()=>{
 const x=fixture();
 for(const task of ['pwsh','powershell','cmd','git-reset','node-eval','dotnet-build'])
  assert.throws(()=>x.service.propose({...req,requestId:'rejectedtask01',task}),/TASK_NOT_ALLOWED/);
 assert.throws(()=>x.service.propose({...req,workspace:'C:\\Windows\\System32'}),/WORKSPACE_DENIED/);
});
test('MCP tools list permits proposal and status only, never approval or execution',()=>{
 const x=fixture();
 const tools=x.service.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools;
 assert.deepEqual(tools.map(t=>t.name),['powershell_propose','powershell_cancel','powershell_job']);
 const p=x.service.rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'powershell_propose',arguments:req}});
 assert.equal(p.result.isError,undefined);
 assert.equal(x.executed(),0);
 const denied=x.service.rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'powershell_execute_approved',arguments:req}});
 assert.equal(denied.result.isError,true);
 assert.equal(x.executed(),0);
});
test('local form checks origin, token and immutable SHA',async()=>{
 const x=fixture();await x.service.start();
 try {
  const p=x.service.propose(req),base='http://127.0.0.1:17486';
  const approvalPage=await fetch(base+'/approve?key='+x.service.uiToken);
  assert.equal(approvalPage.status,200);
  // A same-origin HTML form POST needs a non-null Origin in Chrome.
  // The origin-only Referer policy must not disclose the approval key.
  assert.equal(approvalPage.headers.get('referrer-policy'),'origin');
  assert.match(await approvalPage.text(),/Approve once/);
  const body=new URLSearchParams({id:req.requestId,sha256:p.sha256,approved:'yes'});
  const nullOrigin=await fetch(base+'/decide?key='+x.service.uiToken,
   {method:'POST',headers:{Origin:'null'},body});
  assert.equal(nullOrigin.status,403);assert.equal(x.executed(),0);
  const bad=await fetch(base+'/decide?key='+x.service.uiToken,{method:'POST',body});
  assert.equal(bad.status,403);assert.equal(x.executed(),0);
  const denied=await fetch(base+'/decide?key=wrong',{method:'POST',headers:{Origin:base},body});
  assert.equal(denied.status,403);assert.equal(x.executed(),0);
  const allowed=await fetch(base+'/decide?key='+x.service.uiToken,
   {method:'POST',headers:{Origin:base},body});
  assert.equal(allowed.status,200);assert.equal(x.executed(),1);
  x.finish();await flush();
 }finally{await x.service.stop();}
});

test('MCP cancellation does not start a command and cannot be reversed',()=>{
 const x=fixture(),p=x.service.propose(req);
 const cancelled=x.service.rpc({jsonrpc:'2.0',id:5,method:'tools/call',
  params:{name:'powershell_cancel',arguments:{requestId:req.requestId}}});
 assert.equal(JSON.parse(cancelled.result.content[0].text).state,'CANCELLED');
 assert.equal(x.executed(),0);
 assert.throws(()=>x.service.decide(req.requestId,p.sha256,true),/NOT_PENDING/);
});

test('MCP endpoint refuses missing/incorrect token, then returns tool metadata',async()=>{
 const x=fixture();await x.service.start();
 try{
  const url='http://127.0.0.1:17486/mcp', request={jsonrpc:'2.0',id:1,method:'tools/list'};
  const denied=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
  assert.equal(denied.status,401);
  const allowed=await fetch(url,{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+x.service.agentToken},body:JSON.stringify(request)});
  assert.equal(allowed.status,200);
  const list=(await allowed.json()).result.tools.map(x=>x.name);
  assert.deepEqual(list,['powershell_propose','powershell_cancel','powershell_job']);
  assert.equal(x.executed(),0);
 }finally{await x.service.stop();}
});

test('chat-only readonly mode is disabled by default and rejects direct dispatch',()=>{
 const x=fixture();
 assert.throws(()=>x.service.chatReadonly(req),/CHAT_READONLY_DISABLED/);
 assert.equal(x.executed(),0);
});

test('opt-in chat readonly mode exposes only one additional allowlisted MCP tool',async()=>{
 let started=0;
 const service=new PowerShellApprovalService({root:'C:\\\\Engineering',chatReadonlyEnabled:true,
  workspaceCheck:()=>workspace,
  run:async()=>{started++;return {state:'FINISHED',exitCode:0,stdout:'5.1',stderr:''};}});
 const list=service.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools;
 assert.deepEqual(list.map(x=>x.name),['powershell_propose','powershell_cancel','powershell_job','powershell_chat_readonly']);
 const response=service.rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'powershell_chat_readonly',arguments:req}});
 const created=JSON.parse(response.result.content[0].text);
 assert.equal(created.state,'RUNNING');
 await flush();
 assert.equal(service.status(req.requestId).state,'FINISHED');
 assert.equal(started,1);
 const denied=service.rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'powershell_chat_readonly',arguments:{...req,requestId:'chatunsafe01',task:'cmd'}}});
 assert.equal(denied.result.isError,true);
 assert.equal(started,1);
});
