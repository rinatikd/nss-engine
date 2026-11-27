// Narrowly scoped, executable-free command policy: NEVER accept raw PowerShell.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {canonicalUserWorkspace} from '../ai_collaboration/workspace-policy.mjs';

export const POLICY=Object.freeze({
  'git-status':{exe:'git.exe',args:['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=NUL','status','--short','--branch'],timeout:15000},
  'git-diff-check':{exe:'git.exe',args:['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','diff.external=','diff','--check'],timeout:15000},
  'git-branch':{exe:'git.exe',args:['--no-optional-locks','--no-pager','branch','--show-current'],timeout:15000},
  'git-log':{exe:'git.exe',args:['--no-optional-locks','--no-pager','log','-n','12','--format=%h %ad %s','--date=short'],timeout:15000},
  'dotnet-version':{exe:'dotnet.exe',args:['--version'],timeout:10000},
  'node-version':{exe:'node.exe',args:['--version'],timeout:10000},
  // Fixed literal command: no user-provided script text or interpolation.
  'powershell-version':{exe:'powershell.exe',args:['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()'],timeout:10000},
  // Fixed port-only local listener inventory; never returns credentials or command lines.
  'chrome-lab-ports':{exe:'powershell.exe',args:['-NoProfile','-NonInteractive','-Command',
    '$ports=@(17484,17486,18086);foreach($port in $ports){$open=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue);Write-Output ("{0}: {1}" -f $port,($open.Count -gt 0))}'],timeout:15000}
});
// Resolve trusted executables by explicit paths: NEVER allow PATH/CWD hijack.
const EXECUTABLES=Object.freeze({
  'git.exe':'C:\\Program Files\\Git\\cmd\\git.exe',
  'dotnet.exe':'C:\\Program Files\\dotnet\\dotnet.exe',
  'node.exe':'C:\\Program Files\\nodejs\\node.exe',
  'powershell.exe':'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
});
const MAX_OUTPUT=32768;

export function canonicalWorkspace(candidate){
  return canonicalUserWorkspace(candidate);
}
export function validateTask(task){
  if(typeof task!=='string'||!Object.hasOwn(POLICY,task))throw Error('TASK_NOT_ALLOWED');
  return POLICY[task];
}
function clip(buf){return buf.toString('utf8').slice(0,MAX_OUTPUT);}
export async function runApproved({task,workspace,spawnImpl=spawn}){
  const spec=validateTask(task);
  const cwd=canonicalWorkspace(workspace);
  // Reject relative programs: PATH search can load an attacker-controlled
  // executable in the working tree on Windows.
  const fixed=EXECUTABLES[spec.exe];
  if(!fixed || !fs.existsSync(fixed))throw Error('TRUSTED_EXECUTABLE_NOT_FOUND');
  if(!fs.statSync(fixed).isFile())throw Error('TRUSTED_EXECUTABLE_NOT_FILE');
  return await new Promise(resolve=>{
    let out=Buffer.alloc(0),err=Buffer.alloc(0),finished=false,killTimer;
    const start=Date.now();
    let child;
    try{
      child=spawnImpl(fixed,spec.args,{
        cwd,shell:false,windowsHide:true,
        env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL'},
        stdio:['ignore','pipe','pipe']
      });
    }catch(e){resolve({state:'FAILED_TO_START',reason:e.code||'SPAWN_FAILED'});return;}
    const append=(prev,chunk)=>Buffer.concat([prev,chunk]).subarray(0,MAX_OUTPUT);
    child.stdout?.on('data',b=>out=append(out,b));
    child.stderr?.on('data',b=>err=append(err,b));
    const done=(state,code,reason)=>{
      if(finished)return;
      finished=true;clearTimeout(killTimer);
      resolve({state,exitCode:Number.isInteger(code)?code:null,
        reason:reason||null,stdout:clip(out),stderr:clip(err),
        truncated:out.length===MAX_OUTPUT||err.length===MAX_OUTPUT,
        elapsedMs:Date.now()-start});
    };
    child.on('error',e=>done('FAILED_TO_START',null,e.code||'SPAWN_FAILED'));
    child.on('close',(code,signal)=>done(signal?'TERMINATED':'FINISHED',code,signal));
    killTimer=setTimeout(()=>{
      // Force-stop direct child; implementation must be reviewed for process-tree cleanup
      // before allowing tasks with descendants or mutating effects.
      try{child.kill('SIGKILL');}catch{}
      done('TIMEOUT',null,'EXECUTION_TIMEOUT');
    },spec.timeout);
  });
}
