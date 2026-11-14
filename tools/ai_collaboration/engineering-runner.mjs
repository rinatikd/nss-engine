// Execute only plans minted by engineering-plan.mjs. No shell or arbitrary EXE.
// Caller must persist a unique request claim AND obtain trusted local approval.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {verifyEngineeringPlan} from './engineering-plan.mjs';
const MAX=65536;
const SENSITIVE=/(Bearer\s+)[A-Za-z0-9._-]+|((?:token|password|api[_-]?key|secret)\s*[:=]\s*)[^\s;,]+/gi;
const redact=s=>String(s).replace(SENSITIVE,(value,bearer,assignment)=>
  bearer?bearer+'[REDACTED]':assignment+'[REDACTED]');
export async function runEngineeringPlan(plan,{
  spawnImpl=spawn,
  executableCheck=p=>fs.statSync(p).isFile(),
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
        env:{
          SystemRoot:process.env.SystemRoot||'C:/Windows',
          WINDIR:process.env.WINDIR||'C:/Windows',
          TEMP:process.env.TEMP||'',
          TMP:process.env.TMP||'',
          USERPROFILE:process.env.USERPROFILE||'',
          APPDATA:process.env.APPDATA||'',
          LOCALAPPDATA:process.env.LOCALAPPDATA||'',
          PATH:'C:/Windows/System32;C:/Windows;C:/Program Files/nodejs;C:/Program Files/dotnet;C:/Program Files/Git/cmd',
          GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',
          GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',
          CI:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1'
        }
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
