import test from 'node:test';
import assert from 'node:assert/strict';
import {PowerShellApprovalService} from '../service.mjs';
import {validateExecutionSpec,executableIdentity,assertExecutableIdentity} from '../runner.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createApprovalProxy} from '../approval-proxy.mjs';

const workspace='C:\\Engineering\\NSS_Engine';
const request={requestId:'generaljob01',executable:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
 args:['-NoProfile','-Command','Get-Date'],workspace,purpose:'Проверка текущей даты',
 riskAssessment:'Только чтение системного времени; файлы и настройки не изменяются.',timeoutMs:10000};
function fixture(){
 let now=1000,starts=0,finish;
 const service=new PowerShellApprovalService({root:'C:\\Engineering',port:0,now:()=>now,
  workspaceCheck:(candidate)=>{if(candidate!==workspace&&candidate!=='C:\\Windows\\System32')throw Error('WORKSPACE_DENIED');return candidate;},
  identityCheck:(executable)=>({path:executable,sha256:'a'.repeat(64),size:123}),
  run:async({spec,workspace:cwd,expectedExecutable})=>{starts++;assert.equal(spec.executable,request.executable);assert.equal(expectedExecutable.sha256,'a'.repeat(64));assert.equal(cwd,workspace);
   return await new Promise(resolve=>finish=()=>resolve({state:'FINISHED',exitCode:0,stdout:'OK',stderr:''}));}
 });
 return {service,advance:n=>now+=n,starts:()=>starts,finish:()=>finish?.()};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('general executable and argument proposals are not restricted to a fixed task allowlist',()=>{
 const x=fixture();
 const proposed=x.service.propose(request);
 assert.equal(proposed.state,'PENDING');
 assert.equal(proposed.executable,request.executable);
 assert.deepEqual(proposed.args,request.args);
 assert.equal(x.starts(),0);
 const tools=x.service.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools;
 assert.equal(tools[0].inputSchema.properties.task,undefined);
 assert.equal(tools[0].inputSchema.properties.executable.type,'string');
});

test('no execution before local approval; denial never invokes runner',()=>{
 const x=fixture(),p=x.service.propose(request);
 assert.equal(x.starts(),0);
 assert.deepEqual(x.service.decide(request.requestId,p.sha256,false),{state:'DENIED'});
 assert.equal(x.starts(),0);
 assert.throws(()=>x.service.decide(request.requestId,p.sha256,true),/NOT_PENDING/);
});

test('one-time local approval dispatches exact immutable spec once',async()=>{
 const x=fixture(),p=x.service.propose(request);
 assert.throws(()=>x.service.decide(request.requestId,'bad-hash',true),/HASH_MISMATCH/);
 assert.equal(x.service.decide(request.requestId,p.sha256,true).state,'RUNNING');
 assert.equal(x.starts(),1);
 assert.throws(()=>x.service.decide(request.requestId,p.sha256,true),/NOT_PENDING/);
 x.finish();await flush();
 assert.equal(x.service.status(request.requestId).state,'FINISHED');
 assert.equal(x.service.status(request.requestId).result.stdout,'OK');
});

test('expiry and duplicate request IDs are rejected; workspaces are selected per request',()=>{
 const x=fixture(),p=x.service.propose(request);
 assert.throws(()=>x.service.propose(request),/DUPLICATE_REQUEST_ID/);
 x.advance(90000);
 assert.equal(x.service.status(request.requestId).state,'EXPIRED');
 assert.equal(x.starts(),0);
  const outside=x.service.propose({...request,requestId:'outsidejob01',workspace:'C:\\Windows\\System32'});
  assert.equal(outside.state,'PENDING');
});

test('terminal jobs are reclaimed so the proposal queue remains usable',()=>{
 const x=fixture();
 for(let i=0;i<32;i++){
  const id='queuejob'+String(i).padStart(2,'0');
  const p=x.service.propose({...request,requestId:id});
  x.service.decide(id,p.sha256,false);
 }
 const next=x.service.propose({...request,requestId:'queuejob_next'});
 assert.equal(next.state,'PENDING');
 assert.equal(x.service.jobs.size,32);
});

test('expired pending jobs are reclaimed even when nobody polled their status',()=>{
 const x=fixture();
 for(let i=0;i<32;i++){
  const id='expirejob'+String(i).padStart(2,'0');
  x.service.propose({...request,requestId:id});
 }
 x.advance(90000);
 const next=x.service.propose({...request,requestId:'expirejob_next'});
 assert.equal(next.state,'PENDING');
 assert.equal(x.service.jobs.size,32);
 assert.equal(x.service.jobs.has('expirejob00'),false);
 assert.equal(x.service.jobs.has('expirejob_next'),true);
});

test('request validation rejects malformed paths, NUL arguments, missing risk and excessive timeout',()=>{
 assert.throws(()=>validateExecutionSpec({...request,executable:'powershell.exe'}),/ABSOLUTE_LOCAL_PATH/);
 assert.throws(()=>validateExecutionSpec({...request,args:['bad'+String.fromCharCode(0)+'arg']}),/INVALID_ARGUMENT/);
 assert.throws(()=>validateExecutionSpec({...request,riskAssessment:''}),/MISSING_RISKASSESSMENT/);
 assert.throws(()=>validateExecutionSpec({...request,timeoutMs:9999999}),/INVALID_TIMEOUT/);
});

test('approval UI renders the exact command and risk summary without exposing bearer tokens',async()=>{
 const x=fixture();await x.service.start();
 try{
  x.service.propose(request);
  const base='http://127.0.0.1:'+x.service.port;
  assert.equal((await fetch(base+'/approve')).status,403);
  const page=await fetch(base+'/approve',{headers:{Authorization:'Bearer '+x.service.uiToken}});
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Проверка текущей даты/);
  assert.match(html,/Только чтение системного времени/);
  assert.match(html,/Get-Date/);
  assert.match(html,/SHA-256 исполняемого файла/);
  assert.match(html,new RegExp('a'.repeat(64)));
  assert.match(html,/SHA-256 исполняемого файла/);
  assert.match(html, new RegExp('a'.repeat(64)));
  assert.doesNotMatch(html,new RegExp(x.service.uiToken));
 }finally{await x.service.stop();}
});

test('ephemeral proxy rejects cross-origin POST and forwards an approved local decision',async()=>{
 const x=fixture();await x.service.start();
 const nonce='b'.repeat(64),proxy=createApprovalProxy({servicePort:x.service.port,uiToken:x.service.uiToken,nonce});
 const opened=await proxy.start();
 try{
  x.service.propose(request);
  assert.equal((await fetch(opened.url)).status,200);
  const body=new URLSearchParams({id:request.requestId,sha256:x.service.status(request.requestId).sha256,approved:'yes'});
  const origin='http://127.0.0.1:'+opened.port;
  assert.equal((await fetch(origin+'/'+nonce+'/decide',{method:'POST',headers:{Origin:'null'},body})).status,403);
  assert.equal(x.starts(),0);
  const approved=await fetch(origin+'/'+nonce+'/decide',{method:'POST',headers:{Origin:origin,'content-type':'application/x-www-form-urlencoded'},body});
  assert.equal(approved.status,200);
  assert.equal(x.starts(),1);
  x.finish();await flush();
  assert.equal(x.service.status(request.requestId).state,'FINISHED');
 }finally{await proxy.stop();await x.service.stop();}
});


test('supervisor stop aborts the active job and waits for cancellation confirmation',async()=>{
 let observedSignal;
 const service=new PowerShellApprovalService({root:'C:\\Engineering',port:0,
  workspaceCheck:(candidate)=>candidate,
  identityCheck:(executable)=>({path:executable,sha256:'a'.repeat(64),size:123}),
  run:({signal})=>new Promise(resolve=>{
   observedSignal=signal;
   signal.addEventListener('abort',()=>resolve({state:'CANCELLED',exitCode:null,reason:'SUPERVISOR_STOP_DIRECT_CHILD_ONLY'}),{once:true});
  })
 });
 await service.start();
 const p=service.propose(request);
 assert.equal(service.decide(request.requestId,p.sha256,true).state,'RUNNING');
 assert.equal(observedSignal.aborted,false);
 assert.equal(await service.stop({timeoutMs:1000}),true);
 assert.equal(observedSignal.aborted,true);
 assert.equal(service.status(request.requestId).state,'CANCELLED');
});


test('supervisor stop reports unconfirmed termination when active runner ignores abort',async()=>{
 let release,observedSignal;
 const service=new PowerShellApprovalService({root:'C:\\Engineering',port:0,
  workspaceCheck:(candidate)=>candidate,
  identityCheck:(executable)=>({path:executable,sha256:'a'.repeat(64),size:123}),
  run:({signal})=>new Promise(resolve=>{
   observedSignal=signal;
   release=()=>resolve({state:'FINISHED',exitCode:0,stdout:'late',stderr:''});
  })
 });
 await service.start();
 const p=service.propose(request);
 service.decide(request.requestId,p.sha256,true);
 assert.equal(await service.stop({timeoutMs:20}),false);
 assert.equal(observedSignal.aborted,true);
 assert.equal(service.status(request.requestId).state,'RUNNING');
 release();await flush();
 assert.equal(service.status(request.requestId).state,'FINISHED');
});


test('service shutdown closes a stalled local HTTP client within its bound',async()=>{
 const x=fixture();await x.service.start();
 const socket=net.connect(x.service.port,'127.0.0.1');
 await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
 socket.write('POST /mcp HTTP/1.1\\r\\nHost: 127.0.0.1:'+x.service.port+'\\r\\nAuthorization: Bearer '+x.service.agentToken+'\\r\\nContent-Length: 1000\\r\\n\\r\\n{');
 const started=Date.now();
 const stopped=await x.service.stop({timeoutMs:250});
 assert.equal(stopped,true);
 assert.ok(Date.now()-started<1500);
 assert.equal(socket.destroyed,true);
});

test('MCP authentication protects the proposal and status interface',async()=>{
 const x=fixture();await x.service.start();
 try{
  const url='http://127.0.0.1:'+x.service.port+'/mcp';
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.equal((await fetch(url,{method:'POST',body})).status,401);
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+x.service.agentToken},body});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).result.tools.map(t=>t.name),['powershell_propose','powershell_cancel','powershell_job']);
 }finally{await x.service.stop();}
});

test('executable identity hashes file contents and changes when the file is replaced',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ps-direct-identity-'));
 const file=path.join(dir,'tool.exe');
 try{
  fs.writeFileSync(file,Buffer.from('binary-A'));
  const first=executableIdentity(file);
  assert.equal(first.path,fs.realpathSync.native(file));
  assert.match(first.sha256,/^[a-f0-9]{64}$/);
  fs.writeFileSync(file,Buffer.from('binary-B'));
  const second=executableIdentity(file);
  assert.notEqual(second.sha256,first.sha256);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('executable identity mismatch fails closed before execution approval can be trusted',()=>{
 const expected={path:'C:\\\\Tools\\\\tool.exe',sha256:'a'.repeat(64)};
 assert.equal(assertExecutableIdentity({...expected},expected),true);
 assert.throws(()=>assertExecutableIdentity({...expected,sha256:'b'.repeat(64)},expected),/EXECUTABLE_IDENTITY_MISMATCH/);
 assert.throws(()=>assertExecutableIdentity({...expected,path:'C:\\\\Other\\\\tool.exe'},expected),/EXECUTABLE_IDENTITY_MISMATCH/);
});
