// Supervised PowerShell Direct stack. Tokens are never printed or stored in plaintext.
// UI token is DPAPI CurrentUser-encrypted for an operator-only local launcher.
// The server stays on 127.0.0.1:17486; the stdio tunnel uses an in-memory token.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {PowerShellApprovalService} from './service.mjs';
import {canonicalWorkspace} from './runner.mjs';
import {publishApprovalToken} from './approval-bootstrap.mjs';

const root=process.env.PS_DIRECT_ALLOWED_ROOT;
const client=process.env.PS_DIRECT_TUNNEL_CLIENT;
const runtimeKey=process.env.CONTROL_PLANE_API_KEY;
if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
if(!root||!path.win32.isAbsolute(root)||!fs.existsSync(root))
 throw Error('ALLOWED_ROOT_MISSING');
if(!client||!fs.existsSync(client))throw Error('TUNNEL_CLIENT_MISSING');
if(!runtimeKey)throw Error('CONTROL_PLANE_API_KEY_REQUIRED');

// Feature disabled unless the operator explicitly provisions BOTH the
// exact approved workspaces and an audit directory in the process environment.
const namedWorkspaceRoots=(process.env.PS_DIRECT_NAMED_SUITE_WORKSPACES||'')
  .split(';').map(x=>x.trim()).filter(Boolean)
  .map(workspace=>canonicalWorkspace(workspace,root));
const namedAuditDirectory=process.env.PS_DIRECT_NAMED_SUITE_AUDIT_DIR||null;
if(namedWorkspaceRoots.length && !namedAuditDirectory)
  throw Error('NAMED_AUDIT_DIR_REQUIRED');
const engineeringWorkspaceRoots=(process.env.PS_DIRECT_ENGINEERING_WORKSPACES||'')
  .split(';').map(x=>x.trim()).filter(Boolean)
  .map(workspace=>canonicalWorkspace(workspace,root));
const engineeringAuditDirectory=process.env.PS_DIRECT_ENGINEERING_AUDIT_DIR||null;
if(engineeringWorkspaceRoots.length && !engineeringAuditDirectory)
  throw Error('ENGINEERING_AUDIT_DIR_REQUIRED');
const service=new PowerShellApprovalService({
  root,chatReadonlyEnabled:true,namedWorkspaceRoots,namedAuditDirectory,
  engineeringWorkspaceRoots,engineeringAuditDirectory
});
let child,stopping=false;
async function shutdown(signal='STOP'){
 if(stopping)return;
 stopping=true;
 process.stdout.write('STOPPING_STACK '+signal+'\n');
 if(child&&!child.killed)child.kill();
 try{await service.stop();}catch{}
 // A tunnel that does not exit promptly must be stopped manually via its verified PID.
 process.stdout.write('STOPPED_LOCAL_SERVICE\n');
 process.exitCode=0;
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
 if(engineeringWorkspaceRoots.length && (!tools.includes('powershell_engineering_submit')||
   !tools.includes('powershell_engineering_status')))
   throw Error('ENGINEERING_TOOLS_NOT_REGISTERED');
 if(namedWorkspaceRoots.length && (!tools.includes('powershell_named_suite_submit')||
   !tools.includes('powershell_named_suite_status')))
   throw Error('NAMED_TOOLS_NOT_REGISTERED');
 process.stdout.write('LOCAL_MCP_OK 127.0.0.1:17486 chat_readonly=true named_suites='+String(namedWorkspaceRoots.length>0)+' engineering='+String(engineeringWorkspaceRoots.length>0)+'\n');
 const env={...process.env,PS_DIRECT_AGENT_TOKEN:service.agentToken};
 delete env.PS_DIRECT_CHAT_READONLY_ENABLED; // only the service enables the feature
 child=spawn(client,['run','--profile','powershell-direct-work','--health.listen-addr','127.0.0.1:18086'],
   {env,stdio:['ignore','pipe','pipe'],windowsHide:false,shell:false});
 // Do not pipe arbitrary tunnel logs: they can contain sensitive metadata.
 child.stdout.on('data',()=>{});
 child.stderr.on('data',()=>{});
 child.on('error',e=>{process.stderr.write('TUNNEL_START_FAILED '+(e.code||'ERROR')+'\n');void shutdown('TUNNEL_ERROR');});
 child.on('exit',(code,signal)=>{process.stderr.write('TUNNEL_EXIT '+String(code??signal)+'\n');void shutdown('TUNNEL_EXIT');});
 process.stdout.write('STACK_STARTED tunnel_profile=powershell-direct-work health=http://127.0.0.1:18086/ui\n');
 process.stdout.write('ChatGPT permission MUST remain Always ask; local approval still required by powershell_propose.\n');
 process.stdout.write('Ctrl+C stops this supervised stack. No plaintext token is printed.\n');
}catch(e){
 process.stderr.write('STACK_FAILED '+(e.code||e.message||'UNKNOWN')+'\n');
 await shutdown('START_FAILURE');
 process.exitCode=1;
}
