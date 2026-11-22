import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlRoom, loadActorTokens } from '../consilium/control-room.mjs';

const tokens=[
 {token:'owner-token-abcdefghijklmnopqrstuvwxyz-123456',actor:{id:'owner',role:'owner'}},
 {token:'chatgpt-token-abcdefghijklmnopqrstuvwxyz-123456',actor:{id:'chatgpt',role:'operator'}},
 {token:'claude-token-abcdefghijklmnopqrstuvwxyz-123456',actor:{id:'claude',role:'operator'}},
 {token:'kimi-token-abcdefghijklmnopqrstuvwxyz-123456',actor:{id:'kimi',role:'participant'}},
 {token:'qwen-token-abcdefghijklmnopqrstuvwxyz-123456',actor:{id:'qwen',role:'participant'}}
 ,{token:'deepseek-token-abcdefghijklmnopqrstuvwxyz-123456',actor:{id:'deepseek',role:'participant'}}
 ,{token:'grok-token-abcdefghijklmnopqrstuvwxyz-123456',actor:{id:'grok',role:'participant'}}
 ,{token:'gemini-token-abcdefghijklmnopqrstuvwxyz-123456',actor:{id:'gemini',role:'participant'}}
];
function dir(){return fs.mkdtempSync(path.join(os.tmpdir(),'consilium-room-'));}
async function request(base, token, route, body, {origin=base,host}={}){
 const headers={Authorization:`Bearer ${token}`,Origin:origin};if(body)headers['Content-Type']='application/json';if(host)headers.Host=host;
 return fetch(base+route,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
}

test('Control Room binds to loopback and authenticates both co-operators independently',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  assert.equal((await request(base,'bad-token-abcdefghijklmnopqrstuvwxyz','/api/snapshot')).status,401);
  assert.equal((await request(base,tokens[1].token,'/api/snapshot')).status,200);
  assert.equal((await request(base,tokens[2].token,'/api/snapshot')).status,200);
  const wrongHost=await fetch(base+'/api/snapshot',{headers:{Authorization:`Bearer ${tokens[1].token}`,'X-Forwarded-Host':'evil.example'}});
  assert.equal(wrongHost.status,200);
 }finally{await app.close()}
});

test('co-operators can pause and request stop; owner alone approves decisions',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  const start=await request(base,tokens[1].token,'/api/session/start',{title:'Root-cause analysis',requestId:'start_req_0001'});assert.equal(start.status,201);
  const pause=await request(base,tokens[2].token,'/api/session/pause',{requestId:'pause_req_0001'});assert.equal(pause.status,200);
  const resume=await request(base,tokens[1].token,'/api/session/resume',{requestId:'resume_req_0001'});assert.equal(resume.status,200);
  const proposed=await request(base,tokens[2].token,'/api/decisions',{title:'Record all events',rationale:'Required for traceability',risk:'consequential',evidence:[],requestId:'decision_req_01'});assert.equal(proposed.status,201);
  const data=await proposed.json();const decisionId=data.event.payload.decisionId;
  const review1=await request(base,tokens[1].token,'/api/decisions/review',{decisionId,verdict:'SUPPORT',rationale:'Review one',requestId:'review_req_001'});assert.equal(review1.status,201);
  const denied=await request(base,tokens[1].token,'/api/decisions/approve',{decisionId,requestId:'approve_req_001'});assert.equal(denied.status,403);
  const review2=await request(base,tokens[2].token,'/api/decisions/review',{decisionId,verdict:'SUPPORT',rationale:'Independent review two',requestId:'review_req_002'});assert.equal(review2.status,201);
  const accepted=await request(base,tokens[0].token,'/api/decisions/approve',{decisionId,requestId:'approve_req_002'});assert.equal(accepted.status,200);
  const stop=await request(base,tokens[2].token,'/api/session/stop',{requestId:'stop_req_0001'});assert.equal(stop.status,202);
  const snapshot=await (await request(base,tokens[0].token,'/api/snapshot')).json();assert.equal(snapshot.state.session.status,'STOP_REQUESTED');
 }finally{await app.close()}
});

test('two co-operators control execution while five participants retain expert rights',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  for(const operator of tokens.slice(1)){
   const snapshot=await request(base,operator.token,'/api/snapshot');
   assert.equal(snapshot.status,200,`snapshot read failed for ${operator.actor.id}`);
  }
  const startDenied=await request(base,tokens[5].token,'/api/session/start',{title:'Participant cannot start session',requestId:'start_participant_denied'});assert.equal(startDenied.status,403);
  const start=await request(base,tokens[1].token,'/api/session/start',{title:'Two co-operator control pilot',requestId:'start_equal_ops_01'});assert.equal(start.status,201);
  const pause=await request(base,tokens[2].token,'/api/session/pause',{requestId:'pause_equal_ops_01'});assert.equal(pause.status,200);
  const resume=await request(base,tokens[1].token,'/api/session/resume',{requestId:'resume_equal_ops_01'});assert.equal(resume.status,200);
  const roundProposal=await request(base,tokens[5].token,'/api/rounds/propose',{roundId:'round_proposal_01',objective:'Independent review of the transport race',participants:['chatgpt','claude','kimi','deepseek'],requestId:'round_proposal_req'});assert.equal(roundProposal.status,201);
  const launchDenied=await request(base,tokens[5].token,'/api/rounds/start',{roundId:'round_proposal_01',requestId:'round_start_denied'});assert.equal(launchDenied.status,403);
  const launch=await request(base,tokens[2].token,'/api/rounds/start',{roundId:'round_proposal_01',requestId:'round_start_claude'});assert.equal(launch.status,202);
  const roundProposal2=await request(base,tokens[4].token,'/api/rounds/propose',{roundId:'round_proposal_02',objective:'Second independent review round',participants:['chatgpt','claude','qwen'],requestId:'round_proposal_req_02'});assert.equal(roundProposal2.status,201);
  const launchChatGPT=await request(base,tokens[1].token,'/api/rounds/start',{roundId:'round_proposal_02',requestId:'round_start_chatgpt'});assert.equal(launchChatGPT.status,202);
  const pauseAgain=await request(base,tokens[1].token,'/api/session/pause',{requestId:'pause_equal_ops_02'});assert.equal(pauseAgain.status,200);
  const resumeAgain=await request(base,tokens[2].token,'/api/session/resume',{requestId:'resume_equal_ops_02'});assert.equal(resumeAgain.status,200);
  for(const operator of tokens.slice(1)){
   const comment=await request(base,operator.token,'/api/comments',{text:`Comment from ${operator.actor.id}`,requestId:`comment_${operator.actor.id}_01`});
   assert.equal(comment.status,201,`comment failed for ${operator.actor.id}`);
  }
  const proposal=await request(base,tokens[5].token,'/api/decisions',{title:'Equal expert participation',rationale:'All five participants can submit independent findings and reviews',risk:'consequential',requestId:'decision_equal_ops'});assert.equal(proposal.status,201);
  const decision=await proposal.json(), decisionId=decision.event.payload.decisionId;
  const reviewOrder=[tokens[5],tokens[4],tokens[3],tokens[6],tokens[7],tokens[1],tokens[2]];
  for(let i=0;i<reviewOrder.length;i++){
   const operator=reviewOrder[i];
   const review=await request(base,operator.token,'/api/decisions/review',{decisionId,verdict:'SUPPORT',rationale:`Independent review from ${operator.actor.id}`,requestId:`review_equal_${operator.actor.id}`});
   assert.equal(review.status,201,`review failed for ${operator.actor.id}`);
   if(i<reviewOrder.length-1){
    const snapshot=await (await request(base,tokens[0].token,'/api/snapshot')).json();
    assert.equal(snapshot.state.decisions[0].status,'UNDER_REVIEW');
   }
  }
  const ready=await (await request(base,tokens[0].token,'/api/snapshot')).json();
  assert.equal(ready.state.decisions[0].status,'READY_FOR_OWNER');
  const approved=await request(base,tokens[0].token,'/api/decisions/approve',{decisionId,requestId:'approve_equal_owner'});assert.equal(approved.status,200);
  const stopDenied=await request(base,tokens[4].token,'/api/session/stop',{requestId:'stop_participant_denied'});assert.equal(stopDenied.status,403);
  const stop=await request(base,tokens[1].token,'/api/session/stop',{requestId:'stop_equal_ops_01'});assert.equal(stop.status,202);
 }finally{await app.close()}
});

test('state-changing POST requires same-origin',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{const r=await request(base,tokens[1].token,'/api/session/start',{title:'CSRF test',requestId:'start_req_0003'},{origin:'http://attacker.invalid'});assert.equal(r.status,403)}finally{await app.close()}
});

test('source/artifact handoff is distinct from recipient receipt',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  const sha='b'.repeat(64), commit='c'.repeat(40);
  const linked=await request(base,tokens[1].token,'/api/artifacts',{artifactId:'sourcepack_01',name:'review-source-pack',sha256:sha,sourceCommit:commit,uri:'https://github.com/rinatikd/nss-engine/tree/'+commit,recipients:['claude','kimi'],requestId:'artifact_req_01'});
  assert.equal(linked.status,201);
  const receipt=await request(base,tokens[3].token,'/api/artifacts/receipt',{artifactId:'sourcepack_01',sha256:sha,receiptId:'kimi-receipt-01',requestId:'receipt_req_01'});
  assert.equal(receipt.status,201);
  const snapshot=await (await request(base,tokens[0].token,'/api/snapshot')).json();
  assert.deepEqual(snapshot.state.artifacts[0].receipts.map(x=>x.actor),['kimi']);
 }finally{await app.close()}
});

test('static UI is served with restrictive CSP and without exposing data before auth',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  const page=await fetch(base+'/');assert.equal(page.status,200);const html=await page.text();assert.match(html,/Consilium Control Room/);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  const js=await fetch(base+'/app.js');assert.equal(js.status,200);const jsText=await js.text();assert.ok(jsText.includes('/api/decisions/review'));assert.ok(jsText.includes('/api/rounds/propose'));assert.ok(jsText.includes('/api/rounds/start'));assert.match(jsText,/RESPONSE_UNCERTAIN_RETRY_SAME_REQUEST/);
  assert.match(html,/два равноправных со-оператора/i);assert.match(html,/пять равноправных экспертных участников/i);
  const api=await fetch(base+'/api/snapshot');assert.equal(api.status,401);
 }finally{await app.close()}
});

test('unrecognized actor IDs and role escalation are rejected',()=>{
 const bad=[...tokens,{token:'fake-owner-token-abcdefghijklmnopqrstuvwxyz',actor:{id:'mallory',role:'owner'}}];
 assert.throws(()=>createControlRoom({dataDir:dir(),tokens:bad}),/ACTOR_ROLE_MISMATCH/);
});

test('stop cannot be marked complete by caller-supplied quiescence strings',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  await request(base,tokens[1].token,'/api/session/start',{title:'Stop proof test',requestId:'start_stopproof_01'});
  await request(base,tokens[1].token,'/api/session/stop',{requestId:'stop_stopproof_01'});
  const forged=await request(base,tokens[0].token,'/api/session/stop-confirmed',{bridgeEpoch:'QUIESCENT',unresolved:0,requestId:'stopconfirm_req_01'});
  assert.equal(forged.status,503);
  const snapshot=await (await request(base,tokens[0].token,'/api/snapshot')).json();
  assert.equal(snapshot.state.session.status,'STOP_REQUESTED');
 }finally{await app.close()}
});

test('all authenticated AI participants may update a task assigned to another participant',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  await request(base,tokens[1].token,'/api/decisions',{decisionId:'decision_task_0001',title:'Routine choice',rationale:'Reversible',risk:'routine',requestId:'decision_task_req'});
  await request(base,tokens[1].token,'/api/decisions/review',{decisionId:'decision_task_0001',verdict:'SUPPORT',rationale:'ChatGPT supports',requestId:'review_task_cgpt'});
  await request(base,tokens[2].token,'/api/decisions/review',{decisionId:'decision_task_0001',verdict:'SUPPORT',rationale:'Claude supports',requestId:'review_task_claude'});
  await request(base,tokens[2].token,'/api/tasks',{taskId:'task_kimi_0001',decisionId:'decision_task_0001',title:'Inspect evidence',assignee:'kimi',requestId:'create_task_kimi'});
  const accepted=await request(base,tokens[4].token,'/api/tasks/state',{taskId:'task_kimi_0001',status:'IN_PROGRESS',requestId:'qwen_operator_update'});
  assert.equal(accepted.status,200);
 }finally{await app.close()}
});

test('all write routes require a stable idempotency requestId',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  const r=await request(base,tokens[1].token,'/api/comments',{text:'missing id'},{ });
  assert.equal(r.status,400);
  assert.equal((await r.json()).error,'INVALID_REQUEST_ID');
 }finally{await app.close()}
});

test('authenticated export returns a newline-delimited, hash-chained journal',async()=>{
 const app=createControlRoom({dataDir:dir(),tokens});const a=await app.listen();const base=`http://${a.host}:${a.port}`;
 try{
  await request(base,tokens[1].token,'/api/comments',{text:'first event',requestId:'export_event_001'});
  await request(base,tokens[2].token,'/api/comments',{text:'second event',requestId:'export_event_002'});
  const denied=await fetch(base+'/api/export');assert.equal(denied.status,401);
  const response=await request(base,tokens[0].token,'/api/export');
  assert.equal(response.status,200);assert.ok(response.headers.get('content-type').includes('application/x-ndjson'));
  const body=await response.text();const newline=String.fromCharCode(10);assert.ok(body.endsWith(newline));
  const events=body.trimEnd().split(newline).map(line=>JSON.parse(line));
  assert.equal(events.length,2);assert.equal(events[1].previousHash,events[0].hash);
 }finally{await app.close()}
});

test('loadActorTokens configures two co-operators and five expert participants',()=>{
 const env={
  CONSILIUM_OWNER_TOKEN:'owner-token-abcdefghijklmnopqrstuvwxyz-123456',
  CONSILIUM_CHATGPT_TOKEN:'chatgpt-token-abcdefghijklmnopqrstuvwxyz-123456',
  CONSILIUM_CLAUDE_TOKEN:'claude-token-abcdefghijklmnopqrstuvwxyz-123456',
  CONSILIUM_DEEPSEEK_TOKEN:'deepseek-token-abcdefghijklmnopqrstuvwxyz-123456',
  CONSILIUM_QWEN_TOKEN:'qwen-token-abcdefghijklmnopqrstuvwxyz-123456',
  CONSILIUM_KIMI_TOKEN:'kimi-token-abcdefghijklmnopqrstuvwxyz-123456',
  CONSILIUM_GROK_TOKEN:'grok-token-abcdefghijklmnopqrstuvwxyz-123456',
  CONSILIUM_GEMINI_TOKEN:'gemini-token-abcdefghijklmnopqrstuvwxyz-123456'
 };
 const loaded=loadActorTokens(env);
 assert.equal(loaded.length,8);
 assert.deepEqual(loaded.filter(x=>x.actor.role==='operator').map(x=>x.actor.id).sort(),['chatgpt','claude']);
  assert.deepEqual(loaded.filter(x=>x.actor.role==='participant').map(x=>x.actor.id).sort(),['deepseek','gemini','grok','kimi','qwen']);
 assert.equal(loaded.find(x=>x.actor.id==='owner').actor.role,'owner');
 const app=createControlRoom({dataDir:dir(),tokens:loaded});
 app.ledger.close();
});
