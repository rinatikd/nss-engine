import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProviderJournal } from '../../server/provider-journal.mjs';
const [mode,stateDir,keyHex,bridgeEpoch,...args]=process.argv.slice(2),key=Buffer.from(keyHex,'hex');
const identity=(requestId,taskId)=>({requestId,taskId,providerId:'claude',tabId:42,
  origin:'https://claude.ai',conversationId:'conversation_001',epoch:7});
const journal=options=>new ProviderJournal(stateDir,{hmacKey:key,bridgeEpoch,...options});
const send=value=>new Promise((resolve,reject)=>{if(!process.send)return reject(Error('IPC_CHANNEL_REQUIRED'));process.send(value,e=>e?reject(e):resolve());});
async function journalOnlyOutcomeWithBoundedRetry(journal,requestId,taskId){
  // This test-only retry is limited to a journal append. Production lock acquisition
  // still returns PROVIDER_JOURNAL_LOCK_BUSY after its fixed 1.02s budget.
  for(let attempt=0;;attempt++){
    try{return journal.outcome(identity(requestId,taskId),'BLOCKED','INTERPROCESS_WRITER_TEST');}
    catch(error){
      if(error?.code!=='PROVIDER_JOURNAL_LOCK_BUSY'||attempt>=12)throw error;
      await new Promise(resolve=>setTimeout(resolve,5+attempt*2));
    }
  }
}
const waitFor=type=>new Promise(resolve=>{const f=v=>{if(v?.type!==type)return;process.off('message',f);resolve(v);};process.on('message',f);});
async function main(){
 if(mode==='writer'){
  const [tag,nText]=args,n=Number(nText);if(!/^[A-Za-z0-9_-]{1,20}$/.test(tag)||!Number.isSafeInteger(n)||n<1||n>500)throw Error('WRITER_ARGS');
  const j=journal();await send({type:'ready',pid:process.pid});await waitFor('go');
  for(let i=0;i<n;i++){const x=String(i).padStart(4,'0');await journalOnlyOutcomeWithBoundedRetry(j,tag+'_req_'+x,tag+'_task_'+x);await new Promise(r=>setTimeout(r,1));}
  await send({type:'done',count:n});return;
 }
 if(mode==='reader'||mode==='single-writer'){
  const j=journal();await send({type:'ready',pid:process.pid});await waitFor(mode==='reader'?'read-now':'go');const id=identity('refresh_req_01','refresh_task_01');
  if(mode==='single-writer'){const result=j.outcome(id,'BLOCKED','CROSS_PROCESS_REFRESH_TEST');await send({type:'done',state:result.state});}
  else{const status=j.status(id),events=j.events({after:0,limit:20});await send({type:'reader-result',state:status.state,eventFound:events.some(x=>x.requestId===id.requestId&&x.state==='BLOCKED')});}
  return;
 }
 if(mode==='prepare-race'){
  const [tag]=args,j=journal();await send({type:'ready',pid:process.pid});await waitFor('go');
  try{const x=j.beginPrepare(identity(tag+'_req_0001',tag+'_task_0001'),crypto.createHash('sha256').update(tag).digest('hex'));await send({type:'race-result',result:x.duplicate?'DUPLICATE':'STARTED'});}
  catch(e){await send({type:'race-result',errorCode:e?.code||e?.message||'UNKNOWN'});}return;
 }
 if(mode==='hold-lock'){
  const signal=path.resolve(args[0]||'');if(!signal||!path.isAbsolute(signal))throw Error('LOCK_SIGNAL_REQUIRED');
  const lock=path.join(stateDir,'provider-transactions.jsonl.lock'),ops=Object.create(fs);
  ops.openSync=(file,flags,modeArg)=>{const fd=fs.openSync(file,flags,modeArg);
   if(path.resolve(String(file))===path.resolve(lock)&&flags==='wx'){fs.writeFileSync(signal,JSON.stringify({pid:process.pid}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}return fd;};
  journal({fsOps:ops});throw Error('HOLD_LOCK_DID_NOT_BLOCK');
 }
 if(mode==='probe-lock'){
  const file=path.join(stateDir,'provider-transactions.jsonl'),lock=file+'.lock',before=fs.existsSync(file)?fs.readFileSync(file):null;let errorCode=null;
  try{journal();}catch(e){errorCode=e?.code||e?.message||'UNKNOWN';}
  const after=fs.existsSync(file)?fs.readFileSync(file):null;
  await send({type:'lock-probe',errorCode,lockExists:fs.existsSync(lock),journalUnchanged:before===null?after===null:after!==null&&before.equals(after)});return;
 }
 throw Error('WORKER_MODE_INVALID');
}
main().catch(async e=>{try{await send({type:'worker-error',message:e?.message||'WORKER_FAILED'});}finally{process.exitCode=1;}});
