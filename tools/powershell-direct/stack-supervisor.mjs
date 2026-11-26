// Supervised PowerShell Direct stack. The UI token remains in this process only.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {PowerShellApprovalService} from './service.mjs';
import {createApprovalProxy} from './approval-proxy.mjs';

const root=process.env.PS_DIRECT_ALLOWED_ROOT;
const client=process.env.PS_DIRECT_TUNNEL_CLIENT;
const runtimeKey=process.env.CONTROL_PLANE_API_KEY;
if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
if(!root||!path.win32.isAbsolute(root)||!fs.existsSync(root))
 throw Error('ALLOWED_ROOT_MISSING');
if(!client||!path.win32.isAbsolute(client)||!fs.existsSync(client))
 throw Error('TUNNEL_CLIENT_MISSING');
if(!runtimeKey)throw Error('CONTROL_PLANE_API_KEY_REQUIRED');

const service=new PowerShellApprovalService({root});
let child,proxy,stopping=false;
const SHUTDOWN_BUDGET_MS=15000;
let shutdownDeadline=0;
const remainingShutdownMs=()=>Math.max(0,shutdownDeadline-Date.now());
async function stopTunnelChild(timeoutMs=5000){
 if(!child||child.pid===undefined||child.exitCode!==null||child.signalCode!==null)return true;
 const exited=new Promise(resolve=>child.once('exit',()=>resolve(true)));
 if(!child.killed){try{child.kill();}catch{}}
 let timer;
 const confirmed=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);
 clearTimeout(timer);
 return confirmed;
}
async function shutdown(signal='STOP'){
 if(stopping)return;
 stopping=true;
 process.stdout.write('STOPPING_STACK '+signal+'\n');
 try{await proxy?.stop();}catch{}
 const tunnelStopped=await stopTunnelChild();
 let serviceStopped=false;
 try{serviceStopped=await service.stop({timeoutMs:5000});}catch{}
 if(serviceStopped)process.stdout.write('LOCAL_SERVICE_STOPPED_ACTIVE_JOB_EXIT_CONFIRMED\n');
 else process.stderr.write('ACTIVE_JOB_TERMINATION_UNCONFIRMED: direct child may still be running\n');
 if(tunnelStopped)process.stdout.write('TUNNEL_CHILD_EXIT_CONFIRMED\n');
 else process.stderr.write('TUNNEL_TERMINATION_UNCONFIRMED: process may still be running\n');
 process.exitCode=tunnelStopped&&serviceStopped&&proxyStopped?0:1;
}
process.on('SIGINT',()=>{void shutdown('SIGINT');});
process.on('SIGTERM',()=>{void shutdown('SIGTERM');});

async function assertHealthPortFree(){
 const probe=net.createServer();
 await new Promise((resolve,reject)=>{
  probe.once('error',reject);
  probe.listen(18086,'127.0.0.1',()=>probe.close(resolve));
 });
}
async function waitForHealth(timeoutMs=15000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(stopping)throw Error('STACK_STOPPING');
  try{
   const response=await fetch('http://127.0.0.1:18086/ui',{signal:AbortSignal.timeout(750),redirect:'manual'});
   if(response.status===200)return;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,300));
 }
 throw Error('TUNNEL_HEALTH_TIMEOUT');
}

try{
 await assertHealthPortFree();
 await service.start();
 proxy=createApprovalProxy({servicePort:service.port,uiToken:service.uiToken});
 const approval=await proxy.start();
 const tools=service.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools.map(x=>x.name);
 const required=['powershell_propose','powershell_cancel','powershell_job'];
 if(tools.length!==required.length||required.some(name=>!tools.includes(name)))
  throw Error('UNEXPECTED_MCP_TOOLSET');
 process.stdout.write('LOCAL_MCP_OK 127.0.0.1:'+service.port+' chat_readonly=false\n');
 process.stdout.write('LOCAL_APPROVAL_URL '+approval.url+'\n');
 const env={...process.env,PS_DIRECT_AGENT_TOKEN:service.agentToken};
 delete env.PS_DIRECT_UI_TOKEN;
 child=spawn(client,['run','--profile','powershell-direct-work','--health.listen-addr','127.0.0.1:18086'],
   {env,stdio:['ignore','pipe','pipe'],windowsHide:false,shell:false});
 child.stdout.on('data',()=>{});
 child.stderr.on('data',()=>{});
 child.on('error',e=>{process.stderr.write('TUNNEL_START_FAILED '+(e.code||'ERROR')+'\n');void shutdown('TUNNEL_ERROR');});
 child.on('exit',(code,signal)=>{process.stderr.write('TUNNEL_EXIT '+String(code??signal)+'\n');void shutdown('TUNNEL_EXIT');});
 await waitForHealth();
 if(stopping)throw Error('STACK_STOPPING');
 process.stdout.write('TUNNEL_HEALTH_OK http://127.0.0.1:18086/ui\n');
 process.stdout.write('STACK_READY profile=powershell-direct-work chat_readonly=false\n');
 process.stdout.write('ChatGPT permission MUST remain Always ask; powershell_propose still requires local approval.\n');
 process.stdout.write('Ctrl+C stops this supervised stack. No approval or MCP token is printed.\n');
}catch(e){
 process.stderr.write('STACK_FAILED '+(e.code||e.message||'UNKNOWN')+'\n');
 await shutdown('START_FAILURE');
 process.exitCode=1;
}
