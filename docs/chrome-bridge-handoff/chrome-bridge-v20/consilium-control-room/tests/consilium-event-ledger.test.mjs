import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLedger, projectEvents } from '../consilium/event-ledger.mjs';

function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'consilium-ledger-'));}
const owner={id:'owner',role:'owner'};
const chatgpt={id:'chatgpt',role:'operator'};
const claude={id:'claude',role:'operator'};

test('ledger persists a hash-chained sequence and replays identical request IDs',()=>{
 const dir=temp();let ledger=new EventLedger(dir,{now:()=> '2026-11-22T12:00:00.000Z'});
 const first=ledger.append({type:'comment.added',actor:chatgpt,payload:{text:'Review this claim'},requestId:'comment_req_001'});
 const duplicate=ledger.append({type:'comment.added',actor:chatgpt,payload:{text:'Review this claim'},requestId:'comment_req_001'});
 assert.equal(first.seq,1);assert.equal(duplicate.duplicate,true);assert.equal(ledger.list().length,1);ledger.close();
 ledger=new EventLedger(dir);assert.equal(ledger.list()[0].hash,first.hash);ledger.close();
});

test('idempotency conflict and secret-like payloads fail closed',()=>{
 const ledger=new EventLedger(temp());
 ledger.append({type:'comment.added',actor:chatgpt,payload:{text:'A'},requestId:'same_request_1'});
 assert.throws(()=>ledger.append({type:'comment.added',actor:chatgpt,payload:{text:'B'},requestId:'same_request_1'}),/IDEMPOTENCY_CONFLICT/);
 assert.throws(()=>ledger.append({type:'comment.added',actor:owner,payload:{text:'Bearer abcdefghijklmnopqrstuvwxyz'}}),/SECRET_LIKE_CONTENT_REJECTED/);
 ledger.close();
});

test('single-writer lock blocks a second process instance',()=>{
 const dir=temp();const a=new EventLedger(dir);assert.throws(()=>new EventLedger(dir),/EEXIST|LEDGER/);a.close();
 const b=new EventLedger(dir);b.close();
});

test('tampered event is rejected on reopen',()=>{
 const dir=temp();let ledger=new EventLedger(dir);ledger.append({type:'comment.added',actor:claude,payload:{text:'Original'}});ledger.close();
 const f=path.join(dir,'events.jsonl');const raw=fs.readFileSync(f,'utf8').replace('Original','Tampered');fs.writeFileSync(f,raw);
 assert.throws(()=>new EventLedger(dir),/LEDGER_CHAIN_INVALID_FAIL_CLOSED/);
});

test('decision must be owner-approved before a task may be created',()=>{
 const dir=temp();const ledger=new EventLedger(dir);
 ledger.append({type:'session.started',actor:chatgpt,payload:{sessionId:'session_0001',title:'Architecture review'}});
 ledger.append({type:'decision.proposed',actor:claude,payload:{decisionId:'decision_01',title:'Use event journal',rationale:'Durable audit',evidence:[]}});
 assert.throws(()=>ledger.append({type:'task.created',actor:chatgpt,payload:{taskId:'task_000001',decisionId:'decision_01',title:'Implement',assignee:'claude'}}),/TASK_REQUIRES_ACCEPTED_DECISION/);
 ledger.append({type:'decision.reviewed',actor:chatgpt,payload:{decisionId:'decision_01',verdict:'SUPPORT',rationale:'Matches requirements'}});
 ledger.append({type:'decision.reviewed',actor:claude,payload:{decisionId:'decision_01',verdict:'SUPPORT',rationale:'Independent review agrees'}});
 ledger.append({type:'decision.owner_approved',actor:owner,payload:{decisionId:'decision_01'}});
 ledger.append({type:'task.created',actor:chatgpt,payload:{taskId:'task_000001',decisionId:'decision_01',title:'Implement',assignee:'claude'}});
 const state=projectEvents(ledger.list());assert.equal(state.decisions[0].status,'ACCEPTED');assert.equal(state.tasks[0].status,'READY');ledger.close();
});

test('task verification requires commit and evidence',()=>{
 const dir=temp();const ledger=new EventLedger(dir);
 ledger.append({type:'session.started',actor:chatgpt,payload:{sessionId:'session_0001',title:'Review'}});
 ledger.append({type:'decision.proposed',actor:claude,payload:{decisionId:'decision_01',title:'Decision',rationale:'Reason',risk:'consequential'}});
 ledger.append({type:'decision.reviewed',actor:chatgpt,payload:{decisionId:'decision_01',verdict:'SUPPORT',rationale:'Looks correct'}});
 ledger.append({type:'decision.reviewed',actor:claude,payload:{decisionId:'decision_01',verdict:'SUPPORT',rationale:'Independent agreement'}});
 ledger.append({type:'decision.owner_approved',actor:owner,payload:{decisionId:'decision_01'}});
 ledger.append({type:'task.created',actor:chatgpt,payload:{taskId:'task_000001',decisionId:'decision_01',title:'Test',assignee:'claude'}});
 ledger.append({type:'task.state_changed',actor:claude,payload:{taskId:'task_000001',status:'IN_PROGRESS'}});
 ledger.append({type:'task.state_changed',actor:chatgpt,payload:{taskId:'task_000001',status:'IN_REVIEW'}});
 assert.throws(()=>projectEvents([...ledger.list(),{seq:7,type:'task.state_changed',payload:{taskId:'task_000001',status:'VERIFIED'}}]),/VERIFICATION_EVIDENCE_REQUIRED/);
 ledger.append({type:'task.state_changed',actor:owner,payload:{taskId:'task_000001',status:'VERIFIED',commitSha:'a'.repeat(40),evidence:['run:123','review:abc']}});
 assert.equal(projectEvents(ledger.list()).tasks[0].status,'VERIFIED');ledger.close();
});

test('returned events and snapshots cannot mutate the in-memory ledger',()=>{
 const ledger=new EventLedger(temp());
 const inserted=ledger.append({type:'comment.added',actor:chatgpt,payload:{text:'Original'} });
 inserted.payload.text='Mutated through append result';
 const listed=ledger.list();listed[0].payload.text='Mutated through list result';
 const snapshot=ledger.snapshot();snapshot.state.comments[0].payload.text='Mutated through snapshot';
 assert.equal(ledger.list()[0].payload.text,'Original');
 assert.equal(ledger.snapshot().state.comments[0].payload.text,'Original');
 ledger.close();
});

test('snapshot projection includes state beyond the event page limit',()=>{
 const ledger=new EventLedger(temp());
 for(let i=0;i<2005;i++) ledger.append({type:'comment.added',actor:chatgpt,payload:{text:`event-${i}`}});
 const snapshot=ledger.snapshot({after:0,limit:2000});
 assert.equal(snapshot.events.length,2000);
 assert.equal(snapshot.state.comments.length,2005);
 assert.equal(snapshot.state.lastSequence,2005);
 ledger.close();
});

test('operator can revise a NEEDS_EVIDENCE verdict with a linked immutable review event',()=>{
 const ledger=new EventLedger(temp());
 ledger.append({type:'decision.proposed',actor:chatgpt,payload:{decisionId:'decision_revision_01',title:'Test protocol',rationale:'Initial proposal',risk:'consequential'}});
 const first=ledger.append({type:'decision.reviewed',actor:chatgpt,payload:{decisionId:'decision_revision_01',verdict:'NEEDS_EVIDENCE',rationale:'Need a real browser trace'}});
 ledger.append({type:'decision.reviewed',actor:claude,payload:{decisionId:'decision_revision_01',verdict:'SUPPORT',rationale:'Conditionally support'}});
 const revised=ledger.append({type:'decision.reviewed',actor:chatgpt,payload:{decisionId:'decision_revision_01',verdict:'SUPPORT',rationale:'Trace supplied and verified',evidence:['artifact:trace-01'],revisionOf:first.id}});
 const decision=ledger.snapshot().state.decisions[0];
 assert.equal(decision.status,'READY_FOR_OWNER');
 assert.equal(decision.reviews.find(x=>x.operator==='chatgpt').eventId,revised.id);
 assert.equal(decision.reviewHistory.length,1);
 assert.equal(decision.reviewHistory[0].verdict,'NEEDS_EVIDENCE');
 ledger.close();
});
