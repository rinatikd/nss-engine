/** Real inference verifier. Never substitutes mock Codex or a synthetic model response. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ledger } from './src/ledger.mjs';
import { runOnce } from './src/dispatcher.mjs';
import { CodexCliAdapter } from './src/adapters/codex-cli.mjs';
import { createA2AServer } from './src/server.mjs';

const EXECUTABLE = process.env.A2A_CODEX_EXECUTABLE;
const MODEL = process.env.A2A_CODEX_MODEL || 'qwen2.5:3b';
const OUTPUT = process.env.A2A_EVIDENCE_FILE;
const OLLAMA = 'http://127.0.0.1:11434';
const EXPECTED = 'A2A_CODEX_LOCAL_E2E_OK';
const safeError = error => String(error?.message || error).slice(-1800)
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,'[redacted]')
  .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi,'Bearer [redacted]');
const evidence = { check:'real-http-jsonrpc-sqlite-codex-ollama', passed:false,
  paid_api_calls:0, chatgpt_app_verified:false, windows_isolation_verified:false, model:MODEL,
  requests:[], started_at:new Date().toISOString() };
const annotation = (level,title,value)=>{
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const text=JSON.stringify(value).slice(0,6000).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
  console.log(`::${level} title=${title}::${text}`);
};
async function localJSON(route, options) {
  const r=await fetch(OLLAMA+route,{...options,signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!r.ok)throw new Error('LOCAL_RUNTIME_HTTP_'+r.status);
  return r.json();
}
async function persist() {
  if(OUTPUT)await fs.writeFile(OUTPUT,JSON.stringify(evidence,null,2),'utf8');
}
let root, ledger, server, proxy;
try {
  assert.ok(EXECUTABLE && path.isAbsolute(EXECUTABLE),'Absolute pinned native Codex executable is required');
  assert.ok(['qwen2.5:3b','qwen2.5:7b'].includes(MODEL),'Known local model tag is required');
  const version=spawnSync(EXECUTABLE,['--version'],{encoding:'utf8',shell:false,timeout:5000});
  assert.equal(version.status,0,'Codex --version failed');
  assert.match(version.stdout,/codex-cli 0\.163\.0/,'Pinned tested Codex version required');
  evidence.codex_version=version.stdout.trim();
  evidence.codex_sha256=crypto.createHash('sha256').update(await fs.readFile(EXECUTABLE)).digest('hex');
  evidence.ollama_version=(await localJSON('/api/version')).version;
  const installed=(await localJSON('/api/tags')).models.find(m=>m.name===MODEL);
  assert.ok(installed && /^[a-f0-9]{64}$/.test(installed.digest),'Installed model digest missing');
  evidence.model_digest=installed.digest;
  const metadata=await localJSON('/api/show',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:MODEL})});
  assert.ok(!metadata.remote_host && !metadata.remote_model,'Remote/cloud model is prohibited');
  assert.ok(metadata.model_info && Object.keys(metadata.model_info).length,'Local model metadata required');
  proxy=http.createServer(async(req,res)=>{
    let record;
    try {
      assert.ok(['GET','POST'].includes(req.method),'Unsupported method');
      const route=req.url;
      assert.ok((req.method==='GET' && ['/api/version','/api/tags','/v1/models'].includes(route)) ||
        (req.method==='POST' && route==='/v1/responses'),'Unexpected runtime route');
      assert.ok(!req.headers.authorization && !req.headers['x-api-key'],'No runtime auth header is allowed');
      let body;
      if(req.method==='POST') {
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;assert.ok(size<1_000_000,'Request size cap');chunks.push(chunk);}
        body=Buffer.concat(chunks);const request=JSON.parse(body.toString());
        record={method:req.method,path:route,model:request.model,tool_names:(request.tools||[]).map(t=>t.name||t.type),authorization_present:false};
        evidence.requests.push(record);
        assert.equal(request.model,MODEL,'Unexpected model');
        assert.deepEqual(request.tools||[],[],'Effective Codex tool list must be empty');
      }
      const response=await fetch(OLLAMA+route,{method:req.method,...(body?{body,headers:{'content-type':'application/json'}}:{}),redirect:'error',signal:AbortSignal.timeout(240000)});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'});
      let captured='';
      for await(const chunk of response.body){if(record && captured.length<2_000_000)captured+=Buffer.from(chunk).toString('utf8');res.write(chunk);}
      res.end();
      if(record){
        record.http_status=response.status;
        for(const line of captured.split('\n')){
          if(!line.startsWith('data:'))continue;
          try{const event=JSON.parse(line.slice(5));if(event.type==='response.completed')record.usage=event.response?.usage;}catch{}
        }
      }
    }catch(error){evidence.proxy_error=error.message;if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Local verifier rejected request'}}));}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  root=await fs.mkdtemp(path.join(os.tmpdir(),'a2a-real-codex-'));
  const workspace=path.join(root,'text-only-workspace');await fs.mkdir(workspace);
  const db=path.join(root,'ledger.sqlite');ledger=new Ledger(db);
  const token=crypto.randomBytes(32).toString('hex');
  server=createA2AServer({ledger,token,agentUrl:'http://127.0.0.1:0',defaultRecipient:'codex'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  let rpcId=0;
  async function rpc(method,params){
    const r=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/a2a+json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params}),signal:AbortSignal.timeout(10000)});
    assert.equal(r.status,200);const value=await r.json();assert.ok(!value.error,JSON.stringify(value.error));return value.result;
  }
  const submitted=await rpc('message/send',{message:{role:'user',messageId:'real-local-1',contextId:'real-local-e2e',parts:[{kind:'text',text:`Return this marker verbatim as your entire final response, without punctuation, quotes, explanation or tools:\n${EXPECTED}`}]}});
  assert.equal(submitted.status.state,'submitted');
  const adapter=new CodexCliAdapter({name:'codex',executable:EXECUTABLE,cwd:workspace,model:MODEL,
    provider:'ollama-local',localPort:proxy.address().port,timeoutMs:240000,extraArgs:['--skip-git-repo-check']});
  const send = adapter.send.bind(adapter);
  adapter.send = async task => {
    try{return await send(task);}catch(error){evidence.adapter_error=safeError(error);throw error;}
  };
  const dispatched=await runOnce({ledger,adapter,owner:'real-local-codex-worker',ttlMs:300000});
  evidence.dispatch_status=dispatched.status;
  const completed=await rpc('tasks/get',{id:submitted.id});evidence.task=completed;
  assert.equal(dispatched.status,'completed','Actual CLI dispatch did not complete');
  assert.equal(completed.status.state,'completed');
  const artifact=completed.artifacts?.[0];const answer=artifact?.parts?.[0]?.text;
  assert.equal(answer,EXPECTED,'Actual model final response must match the requested marker');
  assert.ok(artifact.metadata?.invocationId,'An actual Codex session identifier is required');
  const generation=evidence.requests.find(r=>r.http_status===200 && r.usage?.output_tokens>0);
  assert.ok(generation,'Measured Ollama Responses generation is required');
  assert.ok(!evidence.proxy_error,'Verifier rejected a Codex request');
  assert.ok(evidence.requests.every(r=>r.tool_names.length===0 && !r.authorization_present));
  const persisted=new Ledger(db);
  try{assert.equal(persisted.get(submitted.id).state,'completed');assert.equal(persisted.events(submitted.id).find(e=>e.kind==='completed').body.artifact.text,answer);}finally{persisted.close();}
  evidence.passed=true;annotation('notice','A2A real Codex result',{state:completed.status.state,answer,model:MODEL,usage:generation.usage,tool_names:generation.tool_names,paid_api_calls:0});
  console.log('PASS: HTTP -> JSON-RPC -> SQLite -> actual Codex CLI -> local Ollama -> durable result');
}catch(error){evidence.error=error.message;annotation('error','A2A real Codex validation',{error:error.message,dispatch_status:evidence.dispatch_status,proxy_error:evidence.proxy_error,adapter_error:evidence.adapter_error});console.error('FAIL:',error.message);process.exitCode=1;
}finally{
  evidence.finished_at=new Date().toISOString();await persist();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
  ledger?.close();if(root)await fs.rm(root,{recursive:true,force:true});
}
