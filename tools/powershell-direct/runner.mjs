// Narrowly scoped, executable-free command policy: NEVER accept raw PowerShell.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

export const POLICY=Object.freeze({
  'git-status':{exe:'git.exe',args:['--no-optional-locks','status','--short','--branch'],timeout:15000},
  'git-diff-check':{exe:'git.exe',args:['--no-optional-locks','diff','--check'],timeout:15000},
  'dotnet-version':{exe:'dotnet.exe',args:['--version'],timeout:10000},
  'node-version':{exe:'node.exe',args:['--version'],timeout:10000}
});
const MAX_OUTPUT=32768;

export function canonicalWorkspace(candidate,root){
  if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
  if(typeof candidate!=='string'||!path.win32.isAbsolute(candidate)||candidate.startsWith('\\\\'))throw Error('WORKSPACE_NOT_ABSOLUTE');
  const actual=fs.realpathSync.native(candidate);
  const base=fs.realpathSync.native(root);
  const rel=path.win32.relative(base,actual);
  if(rel==='..'||rel.startsWith('..\\')||path.win32.isAbsolute(rel))
    throw Error('WORKSPACE_OUTSIDE_ALLOWED_ROOT');
  if(!fs.statSync(actual).isDirectory())throw Error('WORKSPACE_NOT_DIRECTORY');
  return actual;
}
export function validateTask(task){
  if(typeof task!=='string'||!Object.hasOwn(POLICY,task))throw Error('TASK_NOT_ALLOWED');
  return POLICY[task];
}
function clip(buf){return buf.toString('utf8').slice(0,MAX_OUTPUT);}
export async function runApproved({task,workspace,allowedRoot,spawnImpl=spawn}){
  const spec=validateTask(task);
  const cwd=canonicalWorkspace(workspace,allowedRoot);
  // No shell, PowerShell -Command, cmd /c, script evaluation, or user-supplied args.
  return await new Promise(resolve=>{
    let out=Buffer.alloc(0),err=Buffer.alloc(0),finished=false,killTimer;
    const start=Date.now();
    let child;
    try{
      child=spawnImpl(spec.exe,spec.args,{
        cwd,shell:false,windowsHide:true,
        env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},
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
