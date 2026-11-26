import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const MAX_ARGS=128, MAX_ARG_LENGTH=8192, MAX_TOTAL_ARGS=65536;
const MAX_TIMEOUT=600000, MIN_TIMEOUT=1000, MAX_OUTPUT=65536;

export function validateExecutionSpec(input){
  if(!input||typeof input!=='object')throw Error('EXECUTION_SPEC_REQUIRED');
  const executable=input.executable;
  if(typeof executable!=='string'||!path.win32.isAbsolute(executable))
    throw Error('EXECUTABLE_MUST_BE_ABSOLUTE_LOCAL_PATH');
  const normalized=path.win32.normalize(executable);
  if(normalized===path.win32.parse(normalized).root)throw Error('EXECUTABLE_MUST_BE_FILE');
  if(!Array.isArray(input.args)||input.args.length>MAX_ARGS)throw Error('INVALID_ARGUMENTS');
  let total=0;
  const args=input.args.map(arg=>{
    if(typeof arg!=='string'||arg.includes('\0')||arg.length>MAX_ARG_LENGTH)throw Error('INVALID_ARGUMENT');
    total+=arg.length;
    return arg;
  });
  if(total>MAX_TOTAL_ARGS)throw Error('ARGUMENTS_TOO_LARGE');
  const timeoutMs=input.timeoutMs??30000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<MIN_TIMEOUT||timeoutMs>MAX_TIMEOUT)throw Error('INVALID_TIMEOUT');
  for(const field of ['purpose','riskAssessment']){
    if(typeof input[field]!=='string'||!input[field].trim()||input[field].length>4000)
      throw Error('MISSING_'+field.toUpperCase());
  }
  return {executable:normalized,args,timeoutMs,purpose:input.purpose.trim(),riskAssessment:input.riskAssessment.trim()};
}

export function canonicalWorkspace(candidate,root){
  if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
  if(typeof candidate!=='string'||!path.win32.isAbsolute(candidate))
    throw Error('WORKSPACE_NOT_ABSOLUTE_LOCAL_PATH');
  const actual=fs.realpathSync.native(candidate);
  if(!fs.statSync(actual).isDirectory())throw Error('WORKSPACE_NOT_DIRECTORY');
  // Workspace is selected per request and reviewed locally; it is not fenced to a fixed root.
  return actual;
}

function safeEnvironment(source){
  const allowed=['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH',
    'APPDATA','LOCALAPPDATA','ProgramData','PATH','PATHEXT','COMSPEC'];
  const env={};
  for(const key of allowed)if(source[key]!==undefined)env[key]=source[key];
  return env;
}
function clip(buffer){return buffer.toString('utf8').slice(0,MAX_OUTPUT);}

export async function runApproved({spec,workspace,spawnImpl=spawn,envSource=process.env}){
  const checked=validateExecutionSpec(spec);
  if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
  const executable=fs.realpathSync.native(checked.executable);
  if(!fs.statSync(executable).isFile())throw Error('EXECUTABLE_NOT_FILE');
  const cwd=workspace;
  return await new Promise(resolve=>{
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),finished=false,timedOut=false,timer;
    const started=Date.now();
    let child;
    try{
      child=spawnImpl(executable,checked.args,{
        cwd,shell:false,windowsHide:true,env:safeEnvironment(envSource),
        stdio:['ignore','pipe','pipe']
      });
    }catch(e){resolve({state:'FAILED_TO_START',reason:e.code||'SPAWN_FAILED'});return;}
    const append=(prev,chunk)=>Buffer.concat([prev,chunk]).subarray(0,MAX_OUTPUT);
    child.stdout?.on('data',chunk=>stdout=append(stdout,chunk));
    child.stderr?.on('data',chunk=>stderr=append(stderr,chunk));
    const finish=(state,code,reason)=>{
      if(finished)return;
      finished=true;clearTimeout(timer);
      resolve({state,exitCode:Number.isInteger(code)?code:null,reason:reason||null,
        stdout:clip(stdout),stderr:clip(stderr),
        truncated:stdout.length===MAX_OUTPUT||stderr.length===MAX_OUTPUT,
        elapsedMs:Date.now()-started});
    };
    child.on('error',e=>finish('FAILED_TO_START',null,e.code||'SPAWN_FAILED'));
    child.on('close',(code,signal)=>finish(timedOut?'TIMEOUT':signal?'TERMINATED':'FINISHED',code,timedOut?'EXECUTION_TIMEOUT_DIRECT_CHILD_ONLY':signal));
    timer=setTimeout(()=>{
      timedOut=true;
      try{child.kill('SIGKILL');}catch{}
      // Keep the job RUNNING until the direct child actually emits close.
      // If termination cannot be confirmed, the service remains fail-safe busy.
    },checked.timeoutMs);
  });
}
