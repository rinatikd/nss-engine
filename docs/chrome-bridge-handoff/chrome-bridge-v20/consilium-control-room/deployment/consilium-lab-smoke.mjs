import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlRoom } from '../consilium/control-room.mjs';

const ids = [
  ['owner','owner'], ['chatgpt','operator'], ['claude','operator'],
  ['deepseek','participant'], ['qwen','participant'], ['kimi','participant'],
  ['grok','participant'], ['gemini','participant']
];
const tokens = ids.map(([id,role],index)=>({
  token: ('synthetic-consilium-lab-token-'+id+'-'+String(index).padStart(2,'0')+'-').padEnd(56,'x'),
  actor:{id,role}
}));
const tokenFor = id => tokens.find(item=>item.actor.id===id).token;
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'consilium-lab-smoke-'));
const app=createControlRoom({dataDir,tokens,port:0,host:'127.0.0.1'});
let address;
const request=async (route,{actor,method='GET',body,headers={}}={})=>{
  const h={...headers};
  if(actor)h.Authorization='Bearer '+tokenFor(actor);
  if(body!==undefined){
    h['Content-Type']='application/json';
    h.Origin='http://127.0.0.1:'+address.port;
  }
  const response=await fetch('http://127.0.0.1:'+address.port+route,{
    method,headers:h,body:body===undefined?undefined:JSON.stringify(body)
  });
  return {status:response.status,headers:response.headers,body:await response.text()};
};
try{
  address=await app.listen();
  assert.equal(address.host,'127.0.0.1');
  const health=await request('/healthz');
  assert.equal(health.status,200);
  assert.deepEqual(JSON.parse(health.body),{ok:true,bind:'127.0.0.1',port:address.port});
  const ui=await request('/');
  assert.equal(ui.status,200);
  assert.match(ui.headers.get('content-security-policy')||'',/script-src 'self'/);
  assert.match(ui.body,/Consilium|Control Room/i);
  assert.equal((await request('/api/snapshot')).status,401);
  assert.equal((await request('/api/snapshot',{actor:'chatgpt'})).status,200);
  assert.equal((await request('/api/snapshot',{actor:'claude'})).status,200);

  const start=await request('/api/session/start',{
    actor:'chatgpt',method:'POST',body:{requestId:'smoke-session-start-0001',title:'Disposable Lab smoke'}
  });
  assert.equal(start.status,201);

  const proposal=await request('/api/rounds/propose',{
    actor:'deepseek',method:'POST',
    body:{requestId:'smoke-round-propose-0001',roundId:'smoke-round-0001',
      objective:'Verify role separation in disposable Lab',participants:['chatgpt','claude','deepseek']}
  });
  assert.equal(proposal.status,201);

  const participantLaunch=await request('/api/rounds/start',{
    actor:'deepseek',method:'POST',body:{requestId:'smoke-round-deny-0001',roundId:'smoke-round-0001'}
  });
  assert.equal(participantLaunch.status,202);

  const secondProposal=await request('/api/rounds/propose',{
    actor:'kimi',method:'POST',
    body:{requestId:'smoke-round-propose-0002',roundId:'smoke-round-0002',
      objective:'Second round launched by the co-operator pair',participants:['chatgpt','claude','kimi']}
  });
  assert.equal(secondProposal.status,201);
  const cooperatorLaunch=await request('/api/rounds/start',{
    actor:'claude',method:'POST',body:{requestId:'smoke-round-launch-0002',roundId:'smoke-round-0002'}
  });
  assert.equal(cooperatorLaunch.status,202);

  const participantControl=await request('/api/session/pause',{
    actor:'gemini',method:'POST',body:{requestId:'smoke-session-deny-0001',reason:'role-boundary-test'}
  });
  assert.equal(participantControl.status,200);

  const cooperatorControl=await request('/api/session/resume',{
    actor:'claude',method:'POST',body:{requestId:'smoke-session-resume-0001',reason:'co-operator-parity-test'}
  });
  assert.equal(cooperatorControl.status,200);

  const snapshot=JSON.parse((await request('/api/snapshot',{actor:'owner'})).body);
  assert.ok(snapshot.events.some(e=>e.type==='round.proposed'&&e.actor.id==='deepseek'));
  assert.ok(snapshot.events.some(e=>e.type==='round.started'&&e.actor.id==='deepseek'));
  assert.ok(snapshot.events.some(e=>e.type==='round.started'&&e.actor.id==='claude'));
  console.log(JSON.stringify({ok:true,host:address.host,port:address.port,identities:tokens.length,
    tested:['loopback-only','healthz','ui-csp','unauthenticated-denied','chatgpt-auth','claude-auth',
      'participant-propose','participant-launch','claude-launch','participant-session-control','claude-session-control'],providerDispatch:false,production:false,realSecrets:false}));
}finally{
  await app.close();
  fs.rmSync(dataDir,{recursive:true,force:true});
}
