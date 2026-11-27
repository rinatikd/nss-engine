// Supervised PowerShell Direct stack. Tokens are never printed or stored in plaintext.
// UI token is DPAPI CurrentUser-encrypted for an operator-only local launcher.
// The server stays on 127.0.0.1:17486; the stdio tunnel uses an in-memory token.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {PowerShellApprovalService} from './service.mjs';
import {publishApprovalToken} from './approval-bootstrap.mjs';
import {configureSignedChatApproval} from './chat-approval-config.mjs';

const client=process.env.PS_DIRECT_TUNNEL_CLIENT;
const runtimeKey=process.env.CONTROL_PLANE_API_KEY;
if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
if(!client||!path.win32.isAbsolute(client)||!fs.existsSync(client)||!fs.statSync(client).isFile())
 throw Error('TUNNEL_CLIENT_MISSING');
if(!runtimeKey)throw Error('CONTROL_PLANE_API_KEY_REQUIRED');

// Workspaces are selected per request and canonicalized before the exact
// operation plan is shown for local approval. No persistent folder allowlist.
const namedAuditDirectory=process.env.PS_DIRECT_NAMED_SUITE_AUDIT_DIR||null;
const engineeringAuditDirectory=process.env.PS_DIRECT_ENGINEERING_AUDIT_DIR||null;
for(const value of [namedAuditDirectory,engineeringAuditDirectory].filter(Boolean)){
 if(!path.win32.isAbsolute(value))throw Error('AUDIT_DIR_NOT_ABSOLUTE');
}
const engineeringChatVerifier=configureSignedChatApproval();
if(engineeringChatVerifier&&!engineeringAuditDirectory)
 throw Error('CHAT_APPROVAL_ENGINEERING_AUDIT_REQUIRED');
const service=new PowerShellApprovalService({
  chatReadonlyEnabled:true,namedAuditDirectory,
  engineeringAuditDirectory,engineeringChatVerifier
});
let child,stopping=false,shutdownPromise=null,childClosed=false,tunnelUnexpectedExit=false;
function waitForTunnelClose(timeoutMs=10000){
 if(!child||childClosed)return Promise.resolve(true);
 return new Promise(resolve=>{
  let settled=false;
  const finish=closed=>{
   if(settled)return;
   settled=true;clearTimeout(timer);
   child.removeListener('close',onClose);
   resolve(closed);
  };
  const onClose=()=>{childClosed=true;finish(true);};
  const timer=setTimeout(()=>finish(false),timeoutMs);
  child.once('close',onClose);
  // A signal request is not proof of exit; only the child's close event is.
  if(!child.killed){
   try{child.kill();}catch{}
  }
 });
}
async function shutdown(signal='STOP'){
 if(shutdownPromise)return shutdownPromise;
 stopping=true;
 shutdownPromise=(async()=>{
  process.stdout.write('STOPPING_STACK '+signal+'\n');
  let serviceDrained=false,backgroundJobFailures=0;
  try{
   const result=await service.stop();
   serviceDrained=result?.drained===true;
   backgroundJobFailures=Number.isSafeInteger(result?.backgroundJobsFailed)?result.backgroundJobsFailed:0;
  }catch(error){
   process.stderr.write('LOCAL_SERVICE_DRAIN_FAILED '+(error.code||error.message||'UNKNOWN')+'\n');
  }
  // Never terminate the tunnel while the local service still has an
  // unconfirmed active job or an unpublished terminal audit record.
  const tunnelClosed=serviceDrained?await waitForTunnelClose():false;
  if(serviceDrained&&tunnelClosed&&!tunnelUnexpectedExit){
   process.stdout.write('STOPPED_LOCAL_SERVICE\n');
   process.stdout.write('STOPPED_STACK\n');
   process.exitCode=0;
  }else{
   process.stderr.write('STACK_STOP_INCOMPLETE serviceDrained='+String(serviceDrained)+
    ' backgroundJobFailures='+String(backgroundJobFailures)+
    ' tunnelClosed='+String(tunnelClosed)+' unexpectedTunnelExit='+String(tunnelUnexpectedExit)+'\n');
   process.exitCode=1;
  }
 })();
 return shutdownPromise;
}
process.on('SIGINT',()=>{void shutdown('SIGINT');});
process.on('SIGTERM',()=>{void shutdown('SIGTERM');});

try{
 await service.start();
 // Fail startup if local operator cannot retrieve a protected approval link.
 // Existing MCP approval checks remain mandatory; this cannot approve jobs.
 await publishApprovalToken(service.uiToken);
 process.stdout.write('LOCAL_APPROVAL_BOOTSTRAP_READY (use Open-Approval.ps1)\n');
 const tools=service.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools.map(x=>x.name);
 if(!tools.includes('powershell_chat_readonly'))throw Error('CHAT_TOOL_NOT_REGISTERED');
 if(engineeringAuditDirectory && (!tools.includes('powershell_engineering_submit')||
   !tools.includes('powershell_engineering_status')))
   throw Error('ENGINEERING_TOOLS_NOT_REGISTERED');
 if(namedAuditDirectory && (!tools.includes('powershell_named_suite_submit')||
   !tools.includes('powershell_named_suite_status')))
   throw Error('NAMED_TOOLS_NOT_REGISTERED');
 if(engineeringChatVerifier&&!tools.includes('powershell_engineering_approve_signed'))
   throw Error('CHAT_APPROVAL_TOOL_NOT_REGISTERED');
 process.stdout.write('LOCAL_MCP_OK 127.0.0.1:17486 chat_readonly=true named_suites='+String(!!namedAuditDirectory)+' engineering='+String(!!engineeringAuditDirectory)+' signed_chat_approval='+String(!!engineeringChatVerifier)+'\n');
 const env={...process.env,PS_DIRECT_AGENT_TOKEN:service.agentToken};
 delete env.PS_DIRECT_CHAT_READONLY_ENABLED; // only the service enables the feature
 child=spawn(client,['run','--profile','powershell-direct-work','--health.listen-addr','127.0.0.1:18086'],
   {env,stdio:['ignore','pipe','pipe'],windowsHide:false,shell:false});
 // Do not pipe arbitrary tunnel logs: they can contain sensitive metadata.
 child.stdout.on('data',()=>{});
 child.stderr.on('data',()=>{});
 child.on('error',e=>{tunnelUnexpectedExit=true;process.stderr.write('TUNNEL_START_FAILED '+(e.code||'ERROR')+'\n');void shutdown('TUNNEL_ERROR');});
 child.on('exit',(code,signal)=>{if(!stopping)tunnelUnexpectedExit=true;process.stderr.write('TUNNEL_EXIT '+String(code??signal)+'\n');});
  child.on('close',(code,signal)=>{childClosed=true;const unexpected=!stopping;if(unexpected)tunnelUnexpectedExit=true;process.stderr.write('TUNNEL_CLOSED '+String(code??signal)+'\n');if(unexpected)void shutdown('TUNNEL_EXIT');});
 process.stdout.write('STACK_STARTED tunnel_profile=powershell-direct-work health=http://127.0.0.1:18086/ui\n');
 process.stdout.write('ChatGPT permission MUST remain Always ask; local approval still required by powershell_propose.\n');
 process.stdout.write('Ctrl+C stops this supervised stack. No plaintext token is printed.\n');
}catch(e){
 process.stderr.write('STACK_FAILED '+(e.code||e.message||'UNKNOWN')+'\n');
 await shutdown('START_FAILURE');
 process.exitCode=1;
}
