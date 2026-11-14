// Supervised PowerShell Direct stack. No token is printed or written to disk.
// The server stays on 127.0.0.1:17486; the stdio tunnel uses an in-memory token.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {PowerShellApprovalService} from './service.mjs';

const root=process.env.PS_DIRECT_ALLOWED_ROOT;
const client=process.env.PS_DIRECT_TUNNEL_CLIENT;
const runtimeKey=process.env.CONTROL_PLANE_API_KEY;
if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
if(!root||!path.win32.isAbsolute(root)||!fs.existsSync(root))
 throw Error('ALLOWED_ROOT_MISSING');
if(!client||!fs.existsSync(client))throw Error('TUNNEL_CLIENT_MISSING');
if(!runtimeKey)throw Error('CONTROL_PLANE_API_KEY_REQUIRED');

const service=new PowerShellApprovalService({root,chatReadonlyEnabled:true});
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
 const tools=service.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools.map(x=>x.name);
 if(!tools.includes('powershell_chat_readonly'))throw Error('CHAT_TOOL_NOT_REGISTERED');
 process.stdout.write('LOCAL_MCP_OK 127.0.0.1:17486 chat_readonly=true\n');
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
 process.stdout.write('Ctrl+C stops this supervised stack. No token is printed.\n');
}catch(e){
 process.stderr.write('STACK_FAILED '+(e.code||e.message||'UNKNOWN')+'\n');
 await shutdown('START_FAILURE');
 process.exitCode=1;
}
