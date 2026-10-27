/** Linux local-only Codex service. No model/API credentials or arbitrary CLI tools. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Ledger } from './ledger.mjs';
import { createA2AServer } from './server.mjs';
import { runOnce } from './dispatcher.mjs';
import { CodexCliAdapter } from './adapters/codex-cli.mjs';

export async function startLocalService({ledger,adapter,token, model, readiness=async()=>true}) {
  const controller=new AbortController();
  const state={provider:'ollama-local',model,running:true,model_available:false,last_error:null};
  const server=createA2AServer({ledger,token,defaultRecipient:'codex',agentName:'Codex local text-only',
    health:()=>({ok:true,local_worker:{...state},execution_verified:false})});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const owned={name:'codex',send:task=>adapter.send(task,{signal:controller.signal})};
  const worker=(async()=>{
    while(!controller.signal.aborted){
      try { state.model_available=Boolean(await readiness(controller.signal));state.last_error=state.model_available?null:'LOCAL_MODEL_UNAVAILABLE'; }
      catch {state.model_available=false;state.last_error='LOCAL_MODEL_UNAVAILABLE';}
      if(!controller.signal.aborted && state.model_available)await runOnce({ledger,adapter:owned,owner:'local-text-worker',ttlMs:300000});
      if(!controller.signal.aborted)await new Promise(resolve=>setTimeout(resolve,500));
    }
  })();
  // Stop accepts no new requests, aborts the owned native process group, then
  // lets runOnce durably record UNKNOWN before closing its authoritative ledger.
  let shutdown;
  const stop=()=>shutdown??=(async()=>{
    state.running=false;
    controller.abort();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    try { await worker; } finally { ledger.close(); }
  })();
  return {port:server.address().port,stop,worker};
}
async function runtimeJSON(route,options={}) {
  const response=await fetch('http://127.0.0.1:11434'+route,{...options,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('LOCAL_MODEL_RUNTIME_UNAVAILABLE');
  return response.json();
}
async function main() {
  if(process.platform!=='linux')throw new Error('LINUX_LOCAL_CODEX_ONLY');
  const executable=process.env.A2A_CODEX_EXECUTABLE;
  const model=process.env.A2A_CODEX_MODEL||'qwen2.5:3b';
  const db=process.env.A2A_DB;
  const token=process.env.A2A_API_TOKEN;
  if(!executable||!path.isAbsolute(executable)||!db||!path.isAbsolute(db)||!token||token.length<24)throw new Error('LOCAL_SERVICE_CONFIGURATION_REQUIRED');
  if(!['qwen2.5:3b','qwen2.5:7b'].includes(model))throw new Error('PINNED_LOCAL_MODEL_REQUIRED');
  const version=spawnSync(executable,['--version'],{encoding:'utf8',timeout:5000,shell:false});
  if(version.status!==0||!/^codex-cli 0\.163\.0\s*$/.test(version.stdout))throw new Error('CODEX_VERSION_NOT_TESTED');
  const readiness=async(signal)=>{
  const tags=await runtimeJSON('/api/tags',{signal});
  const installed=tags.models?.find(m=>m.name===model);
  if(!installed||!/^[a-f0-9]{64}$/.test(installed.digest))return false;
  const meta=await runtimeJSON('/api/show',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model}),signal});
  if(meta.remote_host||meta.remote_model||!meta.model_info||!Object.keys(meta.model_info).length)return false;
    return true;
  };
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'a2a-codex-text-'));
  await fs.mkdir(path.dirname(db),{recursive:true});
  const ledger=new Ledger(db);
  let service;
  try {
    const adapter=new CodexCliAdapter({name:'codex',executable,cwd:workspace,model,provider:'ollama-local',timeoutMs:240000,extraArgs:['--skip-git-repo-check']});
    service=await startLocalService({ledger,adapter,token,model,readiness});
    // Private parent pipe handshake: port only, never the bearer/token.
    console.log(JSON.stringify({port:service.port,provider:'ollama-local',model,execution_verified:false}));
    await new Promise((resolve,reject)=>{
      const stop=()=>service.stop().then(resolve,reject);
      process.once('SIGTERM',stop);process.once('SIGINT',stop);
      service.worker.catch(reject);
    });
  } finally {
    if(service)await service.stop();else ledger.close();
    await fs.rm(workspace,{recursive:true,force:true});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(()=>{console.error('LOCAL_CODEX_SERVICE_FAILED: check configured paths, pinned version and local model availability.');process.exitCode=2;});
}
