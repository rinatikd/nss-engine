import test from 'node:test';
import assert from 'node:assert/strict';
import {PowerShellApprovalService} from '../service.mjs';

const workspace='C:\\Engineering\\NSS_Engine';
function fixture(){
 let time=1000,executed=0,release;
 const service=new PowerShellApprovalService({
  root:'C:\\Engineering',port:0,now:()=>time,
  workspaceCheck:(candidate)=>{
   if(candidate!==workspace)throw Error('WORKSPACE_DENIED');
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
  const p=x.service.propose(req),base='http://127.0.0.1:'+x.service.port;
  const approvalPage=await fetch(base+'/approve?key='+x.service.uiToken);
  assert.equal(approvalPage.status,200);
  // A same-origin HTML form POST needs a non-null Origin in Chrome.
  // The origin-only Referer policy must not disclose the approval key.
  assert.equal(approvalPage.headers.get('referrer-policy'),'origin');
  const html=await approvalPage.text();
  assert.match(html,/Engineering Approval/);
  assert.match(html,/Обновить список/);
  assert.match(html,/Разрешить один раз/);
  assert.match(html,/Отклонить/);
  assert.match(html,/approvedcmd01/);
  assert.match(html,/meta http-equiv="refresh" content="10"/);
  assert.match(html,/name="sha256"/);
  assert.doesNotMatch(html,/onload=|onclick=|<script\b/i);
  assert.equal(x.executed(),0); // Rendering and refresh cannot run the job.
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

test('chat-only readonly mode is disabled by default and rejects direct dispatch',()=>{
 const x=fixture();
 assert.throws(()=>x.service.chatReadonly(req),/CHAT_READONLY_DISABLED/);
 assert.equal(x.executed(),0);
});

test('opt-in chat readonly mode exposes only one additional allowlisted MCP tool',async()=>{
 let started=0;
 const service=new PowerShellApprovalService({root:'C:\\Engineering',port:0,chatReadonlyEnabled:true,
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

test('expired named approval card is rejected with 409 and cannot execute',async()=>{
 const x=fixture();await x.service.start();
 try {
  const base='http://127.0.0.1:'+x.service.port;
  const id='expirednamed01',sha='a'.repeat(64);
  const body=new URLSearchParams({kind:'named',id,sha256:sha,approved:'yes'});
  const response=await fetch(base+'/decide?key='+x.service.uiToken,{
   method:'POST',headers:{Origin:base},body,redirect:'manual'});
  assert.equal(response.status,409);
  const result=await response.json();
  assert.equal(result.error,'APPROVAL_NO_LONGER_PENDING');
  assert.equal(x.executed(),0);
 }finally{await x.service.stop();}
});

test('named approval rejects stale plan and redirects after single valid decision',async()=>{
 const x=fixture();await x.service.start();
 try {
  const base='http://127.0.0.1:'+x.service.port;
  const id='currentnamed01',sha='b'.repeat(64);
  let decisions=0,decision;
  x.service.namedPending.set(id,{
   requestId:id,planSha256:sha,suite:'node-test',workspace,
   command:'node',args:['--test'],expiresAt:Date.now()+30000,
   timer:setTimeout(()=>{},30000),
   resolve:result=>{decisions++;decision=result;}
  });
  const attempt=hash=>fetch(base+'/decide?key='+x.service.uiToken,{
   method:'POST',headers:{Origin:base},
   body:new URLSearchParams({kind:'named',id,sha256:hash,approved:'yes'}),
   redirect:'manual'
  });
  const stale=await attempt('c'.repeat(64));
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).error,'APPROVAL_PLAN_CHANGED');
  assert.equal(decisions,0);
  const good=await attempt(sha);
  assert.equal(good.status,303);
  assert.ok(good.headers.get('location')?.startsWith('/approve?key='));
  assert.equal(decisions,1);
  assert.equal(decision.approved,true);
  assert.equal(decision.planSha256,sha);
  const replay=await attempt(sha);
  assert.equal(replay.status,409);
  assert.equal(decisions,1);
  assert.equal(x.executed(),0);
 }finally{
  for(const p of x.service.namedPending.values())clearTimeout(p.timer);
  await x.service.stop();
 }
});

test('engineering approval expiry is enforced at submit decision even before timer fires',async()=>{
 const x=fixture();await x.service.start();
 try{
  const base='http://127.0.0.1:'+x.service.port;
  const id='lateengineer01',sha='d'.repeat(64);
  let count=0,resolution;
  const timer=setTimeout(()=>{},30000);
  x.service.namedPending.set(id,{
   requestId:id,planSha256:sha,suite:'powershell-script',
   workspace,command:'powershell.exe',args:['-NoProfile'],
   expiresAt:Date.now()-1,timer,
   resolve:result=>{count++;resolution=result;}
  });
  const response=await fetch(base+'/decide?key='+x.service.uiToken,{
   method:'POST',headers:{Origin:base},
   body:new URLSearchParams({kind:'named',id,sha256:sha,approved:'yes'}),
   redirect:'manual'
  });
  assert.equal(response.status,410);
  assert.equal((await response.json()).error,'APPROVAL_EXPIRED');
  assert.equal(count,1);
  assert.equal(resolution.approved,false);
  assert.equal(resolution.reason,'APPROVAL_EXPIRED');
  assert.equal(x.service.namedPending.has(id),false);
  assert.equal(x.executed(),0);
 }finally{
  for(const p of x.service.namedPending.values())clearTimeout(p.timer);
  await x.service.stop();
 }
});

test('local UI shows durable completed history without actionable replay form',async()=>{
 const x=fixture();
 x.service.engineeringService={recent:async()=>[{
   requestId:'historicaljob01',suite:'node-test',state:'DENIED',
   reason:'APPROVAL_EXPIRED',updatedAt:'2026-11-15T05:00:00.000Z'
 }]};
 await x.service.start();
 try{
  const base='http://127.0.0.1:'+x.service.port;
  const page=await fetch(base+'/approve?key='+x.service.uiToken);
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Журнал заданий/);
  assert.match(html,/historicaljob01/);
  assert.match(html,/APPROVAL_EXPIRED/);
  assert.doesNotMatch(html,/name="id" value="historicaljob01"/);
  assert.equal(x.executed(),0);
 }finally{await x.service.stop();}
});

test('safe read-only diagnostics include bounded Git and Chrome lab port inventory',()=>{
 const x=fixture();
 const offered=x.service.rpc({jsonrpc:'2.0',id:100,method:'tools/list'}).result.tools
   .find(t=>t.name==='powershell_propose');
 const tasks=offered.inputSchema.properties.task.enum;
 for(const required of ['git-status','git-diff-check','git-branch','git-log',
  'chrome-lab-ports','node-version','dotnet-version','powershell-version'])
  assert.ok(tasks.includes(required),required);
 const a=x.service.propose({...req,requestId:'read_git_branch01',task:'git-branch'});
 assert.equal(a.state,'PENDING');
 const b=x.service.propose({...req,requestId:'read_chrome_port1',task:'chrome-lab-ports'});
 assert.match(b.command,/Get-NetTCPConnection/);
 assert.match(b.command,/17484,17486,18086/);
 assert.ok(!/17381|17382/.test(b.command));
 assert.equal(x.executed(),0);
 for(const task of ['git fetch','git-log --all','node --eval','chrome-lab-ports -Port 17381'])
  assert.throws(()=>x.service.propose({...req,requestId:'unsafe_diag_001',task}),
    /TASK_NOT_ALLOWED/);
});
