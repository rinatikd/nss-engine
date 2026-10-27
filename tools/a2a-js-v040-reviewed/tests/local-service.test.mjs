import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../src/ledger.mjs';
import {startLocalService} from '../src/local-service.mjs';
import {CodexCliAdapter} from '../src/adapters/codex-cli.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('service reports unavailable model and leaves queued task unclaimed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-service-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const ledger=new Ledger(path.join(root,'db.sqlite'));
 ledger.submit({id:'queued-test',contextId:'ctx',sender:'test',recipient:'codex',text:'synthetic'});
 let sends=0;
 const service=await startLocalService({ledger,token:'TEST-local-service-bearer-long-enough',model:'qwen2.5:3b',readiness:async()=>false,adapter:{send:async()=>{sends++;}}});
 try{
  const health=await (await fetch(`http://127.0.0.1:${service.port}/health`)).json();
  assert.equal(health.local_worker.model_available,false);assert.equal(health.execution_verified,false);
  await sleep(600);assert.equal(sends,0);assert.equal(ledger.get('queued-test').state,'submitted');assert.equal(ledger.get('queued-test').attempts,0);
 }finally{await service.stop();}
});

test('service shutdown aborts active dispatch and durably leaves UNKNOWN',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-abort-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const db=path.join(root,'db.sqlite');const ledger=new Ledger(db);
 ledger.submit({id:'abort-test',contextId:'ctx',sender:'test',recipient:'codex',text:'synthetic'});
 let entered;const active=new Promise(resolve=>entered=resolve);
 const service=await startLocalService({ledger,token:'TEST-local-service-bearer-long-enough',model:'qwen2.5:3b',adapter:{send:async(task,{signal})=>{
  entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
 }}});
 await active;await service.stop();await service.stop();
 const reopened=new Ledger(db);
 try{assert.equal(reopened.get('abort-test').state,'unknown');assert.equal(reopened.next('codex'),null);}finally{reopened.close();}
 await assert.rejects(fetch(`http://127.0.0.1:${service.port}/health`));
});

test('adapter pre-abort proves no process was started',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(new CodexCliAdapter({cwd:process.cwd(),executable:'/does-not-exist'}).send({text:'test'},{signal:controller.signal}),e=>e.name==='NotDispatched');
});

test('adapter abort terminates its active native fixture process group',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-abort-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const executable=path.join(root,'fixture.mjs');const marker=path.join(root,'started');
 await fs.writeFile(executable,`#!/usr/bin/env node\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);await fs.chmod(executable,0o755);
 const controller=new AbortController();
 const result=new CodexCliAdapter({cwd:root,executable,timeoutMs:10000}).send({text:'fixture'},{signal:controller.signal});
 // Attach rejection handler immediately while waiting for phase evidence.
 const rejected=assert.rejects(result,/CODEX_ABORTED_OUTCOME_UNKNOWN/);
 for(let i=0;i<100;i++){try{await fs.access(marker);break;}catch{await sleep(10);}}
 const pid=Number(await fs.readFile(marker,'utf8'));controller.abort();await rejected;
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});
