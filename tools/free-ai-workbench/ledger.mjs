// Free AI Workbench: offline task ledger. No model calls, shell or network.
// Node 20+, ESM. JSONL events are append-only; mutations are single-writer,
// fsync-backed, idempotent when callers provide a stable requestId.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROLES=new Set(['planner','developer','reviewer','tester','operator']);
const ACTIONS=new Set(['create','assign','submit','accept','reject']);
const STATES=Object.freeze({
 create:{from:null,to:'QUEUED'},
 assign:{from:'QUEUED',to:'ASSIGNED'},
 submit:{from:'ASSIGNED',to:'IN_REVIEW'},
 accept:{from:'IN_REVIEW',to:'ACCEPTED'},
 reject:{from:'IN_REVIEW',to:'REJECTED'}
});
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;
const MAX_LEDGER_BYTES=4*1024*1024;
const FORMAT_VERSION=2;
const GENESIS_HASH='0'.repeat(64);
const INTERNAL_FIELDS=new Set([
 'formatVersion','recordedAt','eventId','previousHash','payloadHash','eventHash'
]);
const valid=s=>typeof s==='string'&&s.length>0&&s.length<=1000;
const assert=(x,m)=>{if(!x)throw Error(m);};

function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'){
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 }
 return JSON.stringify(value);
}
const sha256=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
function eventPayload(event){
 const out={};
 for(const [key,value] of Object.entries(event))
  if(!INTERNAL_FIELDS.has(key))out[key]=value;
 return out;
}
function parseLine(line,index){
 try{return JSON.parse(line);}
 catch{throw Error('LEDGER_CORRUPT_LINE_'+(index+1));}
}
function readLedger(file){
 if(!fs.existsSync(file))return {events:[],tailHash:GENESIS_HASH};
 const raw=fs.readFileSync(file);
 assert(raw.length<=MAX_LEDGER_BYTES,'LEDGER_TOO_LARGE');
 if(raw.length===0)return {events:[],tailHash:GENESIS_HASH};
 const text=raw.toString('utf8');
 assert(text.endsWith('\n'),'LEDGER_TORN_TAIL');
 const lines=text.slice(0,-1).split('\n');
 const events=[];
 const legacyLines=[];
 const requestIds=new Set();
 let chainStarted=false;
 let tailHash=GENESIS_HASH;
 for(let i=0;i<lines.length;i++){
  const event=parseLine(lines[i],i);
  assert(event&&typeof event==='object'&&!Array.isArray(event),'LEDGER_EVENT_INVALID');
  if(event.requestId!==undefined){
   assert(ID.test(event.requestId),'LEDGER_REQUEST_ID_INVALID');
   assert(!requestIds.has(event.requestId),'LEDGER_DUPLICATE_REQUEST_ID');
   requestIds.add(event.requestId);
  }
  if(event.eventHash===undefined){
   assert(!chainStarted,'LEDGER_LEGACY_AFTER_CHAIN');
   legacyLines.push(lines[i]);
   events.push(event);
   continue;
  }
  assert(event.formatVersion===FORMAT_VERSION,'LEDGER_FORMAT_UNSUPPORTED');
  if(!chainStarted){
   tailHash=legacyLines.length
    ?sha256(legacyLines.join('\n')+'\n')
    :GENESIS_HASH;
   chainStarted=true;
  }
  assert(event.previousHash===tailHash,'LEDGER_CHAIN_PREDECESSOR_MISMATCH');
  const payloadHash=sha256(canonical(eventPayload(event)));
  assert(event.payloadHash===payloadHash,'LEDGER_PAYLOAD_HASH_MISMATCH');
  const unsigned={...event};
  delete unsigned.eventHash;
  const expectedHash=sha256(canonical(unsigned));
  assert(event.eventHash===expectedHash,'LEDGER_CHAIN_HASH_MISMATCH');
  tailHash=event.eventHash;
  events.push(event);
 }
 if(!chainStarted&&legacyLines.length)tailHash=sha256(legacyLines.join('\n')+'\n');
 return {events,tailHash};
}
export function transition(snapshot,event){
 assert(event&&typeof event==='object','EVENT_REQUIRED');
 assert(ACTIONS.has(event.action),'ACTION_DENIED');
 assert(ID.test(event.id||''),'INVALID_ID');
 assert(ID.test(event.actor||''),'INVALID_ACTOR');
 assert(ROLES.has(event.role),'INVALID_ROLE');
 const old=snapshot[event.id]||null;
 const expected=STATES[event.action].from;
 assert((old?old.state:null)===expected,'INVALID_TRANSITION');
 if(event.action==='create'){
  assert(valid(event.title)&&valid(event.project),'TITLE_PROJECT_REQUIRED');
  snapshot[event.id]={id:event.id,project:event.project,title:event.title,
   state:'QUEUED',owner:null,submittedBy:null,reviewedBy:null,
   evidence:[],history:[event]};
 }else{
  const task=snapshot[event.id];
  if(event.action==='assign'){
   assert(event.role==='planner'||event.role==='operator','ASSIGN_ROLE_DENIED');
   assert(ID.test(event.owner||''),'OWNER_REQUIRED');
   task.owner=event.owner;
  }
  if(event.action==='submit'){
   assert(event.actor===task.owner,'ONLY_ASSIGNEE_MAY_SUBMIT');
   assert(valid(event.evidence),'EVIDENCE_REQUIRED');
   task.submittedBy=event.actor;task.evidence.push(event.evidence);
  }
  if(event.action==='accept'||event.action==='reject'){
   assert(event.role==='reviewer'||event.role==='operator','REVIEW_ROLE_DENIED');
   assert(event.actor!==task.submittedBy,'SELF_REVIEW_DENIED');
   assert(valid(event.comment),'REVIEW_COMMENT_REQUIRED');
   task.reviewedBy=event.actor;
  }
  task.state=STATES[event.action].to;
  task.history.push(event);
 }
 return snapshot;
}
export function replay(events){
 const state=Object.create(null);
 for(const event of events)transition(state,event);
 return state;
}
function syncDirectoryBestEffort(dir){
 // Directory fsync is not available on every supported Windows filesystem.
 try{const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{}
}
export function apply(file,event){
 const absolute=path.resolve(file);
 const dir=path.dirname(absolute);
 assert(fs.existsSync(dir),'LEDGER_DIRECTORY_MISSING');
 assert(event&&typeof event==='object'&&!Array.isArray(event),'EVENT_REQUIRED');
 const requestId=event.requestId||crypto.randomUUID();
 assert(ID.test(requestId),'INVALID_REQUEST_ID');
 const payload=eventPayload({...event,requestId});
 const payloadHash=sha256(canonical(payload));
 const lock=absolute+'.lock';
 const lockToken=crypto.randomUUID();
 let lockFd;
 try{
  lockFd=fs.openSync(lock,'wx',0o600);
 }catch(error){
  if(error&&error.code==='EEXIST')throw Error('LEDGER_LOCKED');
  throw error;
 }
 try{
  const lockRecord=JSON.stringify({
   pid:process.pid,host:process.env.COMPUTERNAME||process.env.HOSTNAME||'unknown',
   acquiredAt:new Date().toISOString(),lockToken
  })+'\n';
  fs.writeSync(lockFd,lockRecord,null,'utf8');
  fs.fsyncSync(lockFd);

  const {events,tailHash}=readLedger(absolute);
  const previous=events.find(item=>item.requestId===requestId);
  if(previous){
   assert(previous.payloadHash===payloadHash,'IDEMPOTENCY_CONFLICT');
   return replay(events)[event.id];
  }

  replay([...events,payload]); // validate before the append
  const record={
   ...payload,
   formatVersion:FORMAT_VERSION,
   recordedAt:new Date().toISOString(),
   eventId:crypto.randomUUID(),
   previousHash:tailHash,
   payloadHash
  };
  record.eventHash=sha256(canonical(record));
  const line=JSON.stringify(record)+'\n';
  const fd=fs.openSync(absolute,'a',0o600);
  try{
   const buffer=Buffer.from(line,'utf8');
   let offset=0;
   while(offset<buffer.length)offset+=fs.writeSync(fd,buffer,offset,buffer.length-offset);
   fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  syncDirectoryBestEffort(dir);
  const verified=readLedger(absolute);
  return replay(verified.events)[event.id];
 }finally{
  if(lockFd!==undefined)fs.closeSync(lockFd);
  try{
   const current=fs.readFileSync(lock,'utf8');
   if(current.includes(lockToken))fs.unlinkSync(lock);
  }catch{}
 }
}
export function getState(file){return replay(readLedger(file).events);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [cmd,filename,arg]=process.argv.slice(2);
 if(!['show','event'].includes(cmd)||!filename)throw Error('USAGE: node ledger.mjs show|event ledger.jsonl [event.json]');
 if(cmd==='show')process.stdout.write(JSON.stringify(getState(filename),null,2)+'\n');
 else{
  if(!arg)throw Error('EVENT_JSON_FILE_REQUIRED');
  const body=JSON.parse(fs.readFileSync(arg,'utf8'));
  process.stdout.write(JSON.stringify(apply(filename,body),null,2)+'\n');
 }
}
