import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CodexCliAdapter} from '../src/adapters/codex-cli.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function active(pid) {
 // A killed orphan can remain a zombie briefly until the host reaps it.
 try { const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8'); return stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]!=='Z'; }
 catch(e){if(e.code==='ENOENT')return false;throw e;}
}
async function fixture(t, holdLeader) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-owned-group-'));
 const marker=path.join(root,'child.pid'), ready=path.join(root,'child.ready'), executable=path.join(root,'fixture.mjs');
 let pid;
 t.after(async()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{};await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(executable,`#!/usr/bin/env node
import fs from 'node:fs';import {spawn} from 'node:child_process';
const script="const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync("+JSON.stringify(${JSON.stringify(ready)})+",'ready');setInterval(()=>{},1000)";
const child=spawn(process.execPath,['-e',script],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();
${holdLeader ? 'setInterval(()=>{},1000);' : "const out=process.argv[process.argv.indexOf('--output-last-message')+1];fs.writeFileSync(out,'fixture answer');console.log(JSON.stringify({thread_id:'synthetic-session'}));"}
`);await fs.chmod(executable,0o755);
 return {root,executable,async descendant(){
  for(let i=0;i<100;i++){try{pid=Number(await fs.readFile(marker,'utf8'));return pid;}catch{await sleep(10);}}
  throw new Error('Fixture child did not start');
 },async ready(){
  for(let i=0;i<100;i++){try{await fs.access(ready);return;}catch{await sleep(10);}}
  throw new Error('Fixture child did not install signal handler');
 }};
}
async function assertStopped(pid){
 for(let i=0;i<100;i++){if(!await active(pid))return;await sleep(10);}
 assert.fail('Owned descendant is still running after adapter settlement');
}
test('successful CLI completion stops remaining owned group without inherited pipes',async t=>{
 const f=await fixture(t,false);
 const result=await new CodexCliAdapter({executable:f.executable,cwd:f.root,timeoutMs:5000}).send({text:'synthetic'});
 assert.equal(result.kind,'response');assert.equal(result.text,'fixture answer');
 await assertStopped(await f.descendant());
});
test('abort stops TERM-resistant owned descendant even after leader closes pipes',async t=>{
 const f=await fixture(t,true);const controller=new AbortController();
 const result=new CodexCliAdapter({executable:f.executable,cwd:f.root,timeoutMs:10000}).send({text:'synthetic'},{signal:controller.signal});
 const rejected=assert.rejects(result,/CODEX_ABORTED_OUTCOME_UNKNOWN/);
 const pid=await f.descendant();await f.ready();controller.abort();await rejected;await assertStopped(pid);
});
