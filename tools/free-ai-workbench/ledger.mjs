// Free AI Workbench: offline task ledger. No model calls, shell or network.
// Node 20+, ESM. Append-only JSONL per project; atomic O_EXCL lock prevents
// concurrent mutations. Each task records actor, role and review evidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
const valid=s=>typeof s==='string'&&s.length>0&&s.length<=1000;
const assert=(x,m)=>{if(!x)throw Error(m);};

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
function readEvents(file){
 if(!fs.existsSync(file))return [];
 const str=fs.readFileSync(file,'utf8');
 assert(Buffer.byteLength(str)<=4*1024*1024,'LEDGER_TOO_LARGE');
 return str.split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
export function apply(file,event){
 const dir=path.dirname(path.resolve(file));
 assert(fs.existsSync(dir),'LEDGER_DIRECTORY_MISSING');
 const lock=file+'.lock';
 const fd=fs.openSync(lock,'wx',0o600);
 try{
  const events=readEvents(file);
  replay([...events,event]); // reject invalid transitions before writing
  const stamped={...event,recordedAt:new Date().toISOString(),
   eventId:crypto.randomUUID()};
  fs.appendFileSync(file,JSON.stringify(stamped)+'\n',{encoding:'utf8',flag:'a',mode:0o600});
  return replay([...events,stamped])[event.id];
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function getState(file){return replay(readEvents(file));}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,''))){
 const [cmd,filename,arg]=process.argv.slice(2);
 if(!['show','event'].includes(cmd)||!filename)throw Error('USAGE: node ledger.mjs show|event ledger.jsonl [event.json]');
 if(cmd==='show')process.stdout.write(JSON.stringify(getState(filename),null,2)+'\n');
 else{
  if(!arg)throw Error('EVENT_JSON_FILE_REQUIRED');
  const body=JSON.parse(fs.readFileSync(arg,'utf8'));
  process.stdout.write(JSON.stringify(apply(filename,body),null,2)+'\n');
 }
}
