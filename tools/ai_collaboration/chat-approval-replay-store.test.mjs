import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createDurableApprovalReplayStore} from './chat-approval-replay-store.mjs';
test('durable replay rejection across two new store instances',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'ai-chat-approval-'));
 try{
  const now=()=>1730000000000;
  const a=createDurableApprovalReplayStore({directory,now});
  const b=createDurableApprovalReplayStore({directory,now});
  assert.equal(await a.consumeOnce('issuer:subject:nonce_first_123',now()+60000),true);
  assert.equal(await b.consumeOnce('issuer:subject:nonce_first_123',now()+60000),false);
  const race=await Promise.all([
   a.consumeOnce('issuer:subject:nonce_race_12345',now()+60000),
   b.consumeOnce('issuer:subject:nonce_race_12345',now()+60000)
  ]);
  assert.deepEqual(race.slice().sort(),[false,true]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('reject expired and unsafe keys without filesystem writes',async()=>{
 const directory=path.join(os.tmpdir(),'ai-chat-approval-missing');
 const store=createDurableApprovalReplayStore({directory,now:()=>10});
 await assert.rejects(store.consumeOnce('../../bad',20),/REPLAY_INVALID_INPUT/);
 await assert.rejects(store.consumeOnce('issuer:subject:nonce_1234567',10),/REPLAY_INVALID_INPUT/);
});
