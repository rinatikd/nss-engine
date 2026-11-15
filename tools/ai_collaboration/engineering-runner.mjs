// Execute only plans minted by engineering-plan.mjs. No shell or arbitrary EXE.
// Caller must persist a unique request claim AND obtain trusted local approval.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {verifyEngineeringPlan} from './engineering-plan.mjs';
const MAX=65536;
const GIT_PULL_PROBE_TIMEOUT=8000;
const GCM_EXE='C:/Program Files/Git/mingw64/bin/git-credential-manager.exe';
// Git for Windows bundles GCM in this trusted location. Do not search PATH
// or load caller-supplied credential helpers from the repository.
export function requireTrustedGitCredentialManager({exists=fs.existsSync,stat=fs.statSync}={}){
  if(!exists(GCM_EXE))throw Error('TRUSTED_GCM_NOT_INSTALLED');
  try{if(!stat(GCM_EXE).isFile())throw Error('TRUSTED_GCM_NOT_FILE');}
  catch(e){if(e.message==='TRUSTED_GCM_NOT_FILE')throw e;
    throw Error('TRUSTED_GCM_UNREADABLE');}
  return GCM_EXE;
}

// Git changes are allowed only on a clean, attached branch with a configured upstream.
// Every probe uses a literal argument list, never shell interpolation.
function preflightGitPull(plan,{spawnSyncImpl=spawnSync,env}={}){
  const probe=(args,code)=>{
    const result=spawnSyncImpl(plan.executable,
      ['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=NUL',...args],{
        cwd:plan.cwd,shell:false,windowsHide:true,encoding:'utf8',
        timeout:GIT_PULL_PROBE_TIMEOUT,maxBuffer:65536,env
      });
    if(result.error||result.status!==0||typeof result.stdout!=='string')
      throw Error('GIT_PULL_PREFLIGHT_'+code);
    return result.stdout.trim();
  };
  const branch=probe(['symbolic-ref','--quiet','--short','HEAD'],'DETACHED_OR_INVALID');
  if(!branch||branch.startsWith('-'))throw Error('GIT_PULL_BRANCH_UNSAFE');
  const upstream=probe(['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}'],'UPSTREAM_REQUIRED');
  if(upstream!=='origin/'+branch)throw Error('GIT_PULL_UPSTREAM_UNTRUSTED');
  const origin=probe(['remote','get-url','origin'],'ORIGIN_REQUIRED');
  if(!['https://github.com/rinatikd/nss-engine.git',
        'https://github.com/rinatikd/nss-engine'].includes(origin))
    throw Error('GIT_PULL_ORIGIN_NOT_ALLOWLISTED');
  const dirty=probe(['status','--porcelain=v1','--untracked-files=all'],'STATUS_FAILED');
  if(dirty!=='')throw Error('GIT_PULL_WORKTREE_NOT_CLEAN');
  const state=probe(['rev-parse','--verify','HEAD'],'HEAD_INVALID');
  if(!/^[0-9a-f]{40,64}$/i.test(state))throw Error('GIT_PULL_HEAD_INVALID');
}

const SENSITIVE=/(Bearer\s+)[A-Za-z0-9._-]+|((?:token|password|api[_-]?key|secret)\s*[:=]\s*)[^\s;,]+/gi;
const redact=s=>String(s).replace(SENSITIVE,(value,bearer,assignment)=>
  bearer?bearer+'[REDACTED]':assignment+'[REDACTED]');
export async function runEngineeringPlan(plan,{
  spawnImpl=spawn,
  spawnSyncImpl=spawnSync,
  executableCheck=p=>fs.statSync(p).isFile(),
  credentialManagerCheck=requireTrustedGitCredentialManager,
  platform=process.platform
}={}){
  verifyEngineeringPlan(plan);
  if(platform!=='win32')throw Error('WINDOWS_ONLY_EXECUTION');
  if(!path.win32.isAbsolute(plan.executable)||!executableCheck(plan.executable))
    throw Error('TRUSTED_EXECUTABLE_MISSING');
  if(plan.sourcePath){
    // If the operator approved source A, never silently execute source B.
    const current=createHash('sha256').update(fs.readFileSync(plan.sourcePath)).digest('hex');
    if(current!==plan.sourceSha256)throw Error('SOURCE_CHANGED_SINCE_APPROVAL');
  }
  const restrictedEnv={
    SystemRoot:process.env.SystemRoot||'C:/Windows',
    WINDIR:process.env.WINDIR||'C:/Windows',
    TEMP:process.env.TEMP||'',
    TMP:process.env.TMP||'',
    USERPROFILE:process.env.USERPROFILE||'',
    APPDATA:process.env.APPDATA||'',
    LOCALAPPDATA:process.env.LOCALAPPDATA||'',
    PATH:'C:/Windows/System32;C:/Windows;C:/Program Files/nodejs;C:/Program Files/dotnet;C:/Program Files/Git/cmd',
    GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',
    GCM_INTERACTIVE:'0',GCM_GUI_PROMPT:'0',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',
    CI:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1'
  };
  if(plan.operation==='git-pull-ff-only'){
    credentialManagerCheck();
    preflightGitPull(plan,{spawnSyncImpl,env:restrictedEnv});
  }
  return await new Promise((resolve,reject)=>{
    const start=Date.now();let out='',err='',truncated=false,settled=false,timedOut=false;
    let child,timeout,watchdog;
    const append=(previous,buf)=>{
      const available=MAX-Buffer.byteLength(previous,'utf8');
      if(available<=0){truncated=true;return previous;}
      if(buf.length>available)truncated=true;
      return previous+buf.subarray(0,available).toString('utf8');
    };
    const finish=data=>{
      if(settled)return;
      settled=true;clearTimeout(timeout);clearTimeout(watchdog);
      resolve({...data,stdout:redact(out),stderr:redact(err),
        truncated,elapsedMs:Date.now()-start});
    };
    try{
      child=spawnImpl(plan.executable,[...plan.args],{
        cwd:plan.cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],
        env:restrictedEnv
      });
    }catch(e){reject(Error('ENGINEERING_SPAWN_FAILED'));return;}
    child.stdout?.on('data',b=>out=append(out,b));
    child.stderr?.on('data',b=>err=append(err,b));
    child.on('error',()=>finish({exitCode:null,state:'START_FAILED'}));
    child.on('close',(code,signal)=>finish({exitCode:code??null,signal:signal||null,
      state:timedOut?'TIMED_OUT':(code===0?'FINISHED':'FAILED'),timedOut,
      terminationUnconfirmed:false}));
    timeout=setTimeout(()=>{
      timedOut=true;
      // No automatic replay after timeout. PID-specific stop only.
      if(Number.isSafeInteger(child.pid)&&child.pid>0){
        const killer=spawn('C:/Windows/System32/taskkill.exe',
          ['/PID',String(child.pid),'/T','/F'],
          {shell:false,windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>{try{child.kill('SIGKILL')}catch{}});
      }else{try{child.kill('SIGKILL')}catch{}}
      watchdog=setTimeout(()=>finish({exitCode:null,state:'TIMED_OUT',
        timedOut:true,terminationUnconfirmed:true}),5000);
    },plan.timeoutMs);
  });
}
