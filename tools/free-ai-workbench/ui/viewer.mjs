// Read-only JSONL Workbench projection. Browser-safe ES module; no network or storage.
const ROLES=new Set(['planner','developer','reviewer','tester','operator']);
const ACTIONS=new Set(['create','assign','submit','accept','reject']);
const STATES={
 create:{from:null,to:'QUEUED'},
 assign:{from:'QUEUED',to:'ASSIGNED'},
 submit:{from:'ASSIGNED',to:'IN_REVIEW'},
 accept:{from:'IN_REVIEW',to:'ACCEPTED'},
 reject:{from:'IN_REVIEW',to:'REJECTED'}
};
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;
const INTERNAL_FIELDS=new Set(['formatVersion','recordedAt','eventId','previousHash','payloadHash','eventHash']);
const GENESIS_HASH='0'.repeat(64);
const MAX_BYTES=4*1024*1024;
const assert=(condition,code)=>{if(!condition)throw Error(code);};

function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'){
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 }
 return JSON.stringify(value);
}
function payloadOf(event){
 const payload={};
 for(const [key,value] of Object.entries(event))
  if(!INTERNAL_FIELDS.has(key))payload[key]=value;
 return payload;
}
async function sha256(value){
 assert(globalThis.crypto?.subtle,'WEBCRYPTO_UNAVAILABLE');
 const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function replay(events){
 const tasks=Object.create(null);
 for(let index=0;index<events.length;index++){
  const event=events[index];
  assert(event&&typeof event==='object'&&!Array.isArray(event),'LEDGER_EVENT_INVALID_'+(index+1));
  assert(ACTIONS.has(event.action),'ACTION_DENIED_'+(index+1));
  assert(ID.test(event.id||''),'INVALID_ID_'+(index+1));
  assert(ID.test(event.actor||''),'INVALID_ACTOR_'+(index+1));
  assert(ROLES.has(event.role),'INVALID_ROLE_'+(index+1));
  const current=tasks[event.id]||null;
  assert((current?current.state:null)===STATES[event.action].from,'INVALID_TRANSITION_'+(index+1));
  if(event.action==='create'){
   assert(typeof event.title==='string'&&event.title.length>0,'TITLE_REQUIRED_'+(index+1));
   assert(typeof event.project==='string'&&event.project.length>0,'PROJECT_REQUIRED_'+(index+1));
   tasks[event.id]={id:event.id,title:event.title,project:event.project,state:'QUEUED',
    owner:null,submittedBy:null,reviewedBy:null,evidence:[],history:[event]};
   continue;
  }
  const task=tasks[event.id];
  if(event.action==='assign'){
   assert(event.role==='planner'||event.role==='operator','ASSIGN_ROLE_DENIED_'+(index+1));
   assert(ID.test(event.owner||''),'OWNER_REQUIRED_'+(index+1));
   task.owner=event.owner;
  }else if(event.action==='submit'){
   assert(event.actor===task.owner,'ONLY_ASSIGNEE_MAY_SUBMIT_'+(index+1));
   assert(typeof event.evidence==='string'&&event.evidence.length>0,'EVIDENCE_REQUIRED_'+(index+1));
   task.submittedBy=event.actor;
   task.evidence.push(event.evidence);
  }else{
   assert(event.role==='reviewer'||event.role==='operator','REVIEW_ROLE_DENIED_'+(index+1));
   assert(event.actor!==task.submittedBy,'SELF_REVIEW_DENIED_'+(index+1));
   assert(typeof event.comment==='string'&&event.comment.length>0,'REVIEW_COMMENT_REQUIRED_'+(index+1));
   task.reviewedBy=event.actor;
  }
  task.state=STATES[event.action].to;
  task.history.push(event);
 }
 return Object.values(tasks);
}

export async function projectLedger(rawText){
 assert(typeof rawText==='string','LEDGER_TEXT_REQUIRED');
 const byteLength=new TextEncoder().encode(rawText).length;
 assert(byteLength<=MAX_BYTES,'LEDGER_TOO_LARGE');
 assert(rawText.length>0,'LEDGER_EMPTY');
 assert(rawText.endsWith('\n'),'LEDGER_TORN_TAIL');
 const lines=rawText.slice(0,-1).split('\n');
 const events=[],legacyLines=[],requestIds=new Set();
 let chainStarted=false,tailHash=GENESIS_HASH,v2Count=0;
 for(let i=0;i<lines.length;i++){
  let event;
  try{event=JSON.parse(lines[i]);}catch{throw Error('LEDGER_CORRUPT_LINE_'+(i+1));}
  assert(event&&typeof event==='object'&&!Array.isArray(event),'LEDGER_EVENT_INVALID_'+(i+1));
  if(event.requestId!==undefined){
   assert(ID.test(event.requestId),'LEDGER_REQUEST_ID_INVALID_'+(i+1));
   assert(!requestIds.has(event.requestId),'LEDGER_DUPLICATE_REQUEST_ID_'+(i+1));
   requestIds.add(event.requestId);
  }
  if(event.eventHash===undefined){
   assert(!chainStarted,'LEDGER_LEGACY_AFTER_CHAIN_'+(i+1));
   legacyLines.push(lines[i]);
   events.push(event);
   continue;
  }
  assert(event.formatVersion===2,'LEDGER_FORMAT_UNSUPPORTED_'+(i+1));
  if(!chainStarted){
   tailHash=legacyLines.length?await sha256(legacyLines.join('\n')+'\n'):GENESIS_HASH;
   chainStarted=true;
  }
  assert(event.previousHash===tailHash,'LEDGER_CHAIN_PREDECESSOR_MISMATCH_'+(i+1));
  const expectedPayloadHash=await sha256(canonical(payloadOf(event)));
  assert(event.payloadHash===expectedPayloadHash,'LEDGER_PAYLOAD_HASH_MISMATCH_'+(i+1));
  const unsigned={...event};
  delete unsigned.eventHash;
  const expectedEventHash=await sha256(canonical(unsigned));
  assert(event.eventHash===expectedEventHash,'LEDGER_CHAIN_HASH_MISMATCH_'+(i+1));
  tailHash=event.eventHash;
  v2Count++;
  events.push(event);
 }
 const tasks=replay(events);
 return {
  tasks,
  eventCount:events.length,
  legacyEventCount:legacyLines.length,
  v2EventCount:v2Count,
  integrity:v2Count>0?'V2_CHAIN_VERIFIED':'LEGACY_UNCHAINED',
  tailHash,
  requestCount:requestIds.size
 };
}
