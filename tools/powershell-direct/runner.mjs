import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const MAX_ARGS=128, MAX_ARG_LENGTH=8192, MAX_TOTAL_ARGS=65536;
const MAX_TIMEOUT=600000, MIN_TIMEOUT=1000, MAX_OUTPUT=65536, MAX_EXECUTABLE_BYTES=1024*1024*1024;

export function executableIdentity(candidate){
  const resolved=fs.realpathSync.native(candidate);
  const fd=fs.openSync(resolved,'r');
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile())throw Error('EXECUTABLE_NOT_FILE');
    if(stat.size>MAX_EXECUTABLE_BYTES)throw Error('EXECUTABLE_TOO_LARGE_TO_VERIFY');
    const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
    let position=0,read;
    while((read=fs.readSync(fd,buffer,0,buffer.length,position))>0){
      hash.update(buffer.subarray(0,read));position+=read;
    }
    const after=fs.fstatSync(fd);
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('EXECUTABLE_CHANGED_DURING_HASH');
    return {path:resolved,sha256:hash.digest('hex'),size:stat.size};
  }finally{fs.closeSync(fd);}
}

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

export async function runApproved({spec,workspace,spawnImpl=spawn,envSource=process.env,signal,expectedExecutable}){
  const checked=validateExecutionSpec(spec);
  if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
  if(signal?.aborted)return {state:'CANCELLED',exitCode:null,reason:'CANCELLED_BEFORE_START',stdout:'',stderr:'',elapsedMs:0};
  const identity=executableIdentity(checked.executable);
  if(expectedExecutable&&(identity.path!==expectedExecutable.path||identity.sha256!==expectedExecutable.sha256))
    throw Error('EXECUTABLE_IDENTITY_MISMATCH');
  const executable=identity.path;
  const cwd=workspace;
  return await new Promise(resolve=>{
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),finished=false,timedOut=false,cancelled=false,timer;
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
      signal?.removeEventListener('abort',onAbort);
      resolve({state,exitCode:Number.isInteger(code)?code:null,reason:reason||null,
        stdout:clip(stdout),stderr:clip(stderr),
        truncated:stdout.length===MAX_OUTPUT||stderr.length===MAX_OUTPUT,
        elapsedMs:Date.now()-started});
    };
    const terminate=()=>{
      try{child.kill();}catch{}
      // Keep the job active until close confirms that the direct child exited.
    };
    const onAbort=()=>{cancelled=true;terminate();};
    child.on('error',e=>finish('FAILED_TO_START',null,e.code||'SPAWN_FAILED'));
    child.on('close',(code,signalName)=>finish(timedOut?'TIMEOUT':cancelled?'CANCELLED':signalName?'TERMINATED':'FINISHED',code,
      timedOut?'EXECUTION_TIMEOUT_DIRECT_CHILD_ONLY':cancelled?'SUPERVISOR_STOP_DIRECT_CHILD_ONLY':signalName));
    if(signal?.aborted)onAbort();
    else signal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>{timedOut=true;terminate();},checked.timeoutMs);
  });
}
