import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProviderJournal } from '../server/provider-journal.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),worker=path.join(here,'fixtures','provider-journal-interprocess-worker.mjs');
const key=crypto.randomBytes(32),epoch='bridge_epoch_interprocess_01';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'provider-journal-process-'));
const make=(dir,bridgeEpoch=epoch)=>new ProviderJournal(dir,{hmacKey:key,bridgeEpoch});
const id=(requestId,taskId)=>({requestId,taskId,providerId:'claude',tabId:42,origin:'https://claude.ai',conversationId:'conversation_001',epoch:7});
const launch=(mode,dir,...args)=>fork(worker,[mode,dir,key.toString('hex'),epoch,...args],{stdio:['ignore','ignore','inherit','ipc']});
function next(child,type,ms=10000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',handler);reject(Error('WORKER_MESSAGE_TIMEOUT'));},ms);const handler=v=>{clearTimeout(timer);if(v?.type==='worker-error')reject(Error('WORKER_FAILED:'+v.message));else if(v?.type!==type)reject(Error('UNEXPECTED_WORKER_MESSAGE:'+String(v?.type)));else resolve(v);};child.once('message',handler);});}
const send=(child,type)=>new Promise((resolve,reject)=>child.send({type},e=>e?reject(e):resolve()));
const exit=child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve));
async function stop(child,signal='SIGKILL'){if(child.exitCode===null&&child.signalCode===null){child.kill(signal);await exit(child);}}
async function waitFile(file){const end=Date.now()+10000;while(Date.now()<end){if(fs.existsSync(file))return;await new Promise(r=>setTimeout(r,10));}throw Error('LOCK_OWNER_SIGNAL_TIMEOUT');}
test('two OS processes append a contiguous hash chain from preloaded journal instances',{timeout:20000},async()=>{
 const dir=temp(),ws=[launch('writer',dir,'procA','24'),launch('writer',dir,'procB','24')];try{
  const ready=await Promise.all(ws.map(w=>next(w,'ready')));assert.equal(new Set(ready.map(x=>x.pid)).size,2);
  for(const w of ws)await send(w,'go');await Promise.all(ws.map(w=>next(w,'done')));await Promise.all(ws.map(exit));
  const rows=fs.readFileSync(path.join(dir,'provider-transactions.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
  assert.equal(rows.length,48);let prev='0'.repeat(64);rows.forEach((x,i)=>{assert.equal(x.seq,i+1);assert.equal(x.prevHash,prev);assert.match(x.hash,/^[a-f0-9]{64}$/);prev=x.hash;});make(dir);
 }finally{await Promise.all(ws.map(w=>stop(w)));fs.rmSync(dir,{recursive:true,force:true});}
});
test('preloaded OS process refreshes status and events committed by another process',{timeout:20000},async()=>{
 const dir=temp(),reader=launch('reader',dir),writer=launch('single-writer',dir);try{
  await Promise.all([next(reader,'ready'),next(writer,'ready')]);await send(writer,'go');assert.equal((await next(writer,'done')).state,'BLOCKED');await exit(writer);
  await send(reader,'read-now');const x=await next(reader,'reader-result');assert.equal(x.state,'BLOCKED');assert.equal(x.eventFound,true);await exit(reader);
 }finally{await Promise.all([stop(reader),stop(writer)]);fs.rmSync(dir,{recursive:true,force:true});}
});
test('two OS processes cannot concurrently begin prepare for the same tab',{timeout:20000},async()=>{
 const dir=temp(),ws=[launch('prepare-race',dir,'raceA'),launch('prepare-race',dir,'raceB')];try{
  await Promise.all(ws.map(w=>next(w,'ready')));for(const w of ws)await send(w,'go');
  const xs=await Promise.all(ws.map(w=>next(w,'race-result')));assert.equal(xs.filter(x=>x.result==='STARTED').length,1);assert.equal(xs.filter(x=>x.errorCode==='PROVIDER_TAB_QUARANTINED').length,1);await Promise.all(ws.map(exit));
 }finally{await Promise.all(ws.map(w=>stop(w)));fs.rmSync(dir,{recursive:true,force:true});}
});
test('SIGKILL after exclusive lock creation leaves foreign lock and journal untouched',{timeout:20000},async()=>{
 const dir=temp(),signal=path.join(dir,'lock-owner.signal'),file=path.join(dir,'provider-transactions.jsonl'),owner=launch('hold-lock',dir,signal);
 try{await waitFile(signal);assert.ok(fs.existsSync(file+'.lock'));assert.equal(JSON.parse(fs.readFileSync(signal,'utf8')).pid,owner.pid);await stop(owner,'SIGKILL');assert.ok(fs.existsSync(file+'.lock'));
  const probe=launch('probe-lock',dir),x=await next(probe,'lock-probe');assert.equal(x.errorCode,'PROVIDER_JOURNAL_LOCK_BUSY');assert.equal(x.lockExists,true);assert.equal(x.journalUnchanged,true);await exit(probe);
 }finally{await stop(owner,'SIGKILL');fs.rmSync(dir,{recursive:true,force:true});}
});
test('SENT remains SENT after a fresh Bridge epoch reopens the journal',()=>{
 const dir=temp(),request=id('request_sent_01','task_sent_0001'),payloadHash='a'.repeat(64);try{
  const j=make(dir);j.beginPrepare(request,payloadHash);const prepared=j.completePrepare(request,{preparedId:'prepared_sent_01',expiresAt:new Date(Date.now()+60000).toISOString()});
  j.beginCommit(request,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash});j.completeCommit(request,{clickedAt:new Date().toISOString(),clickedSend:true,baseline:0});
  assert.equal(make(dir,'bridge_epoch_after_restart_02').status(request).state,'SENT');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
