import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApprovalSession} from '../extension/approval-session.js';

let clock=1000;
let nextTimer=0;
const timers=new Map();
const session=()=>new ApprovalSession({
  now:()=>clock,
  setTimeoutImpl:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},
  clearTimeoutImpl:id=>timers.delete(id)
});
const request=(id='req-1')=>({id,command:'agent_send',origin:'https://claude.ai',tabId:7,expires:clock+4000});
test('pending approval survives panel-independent listing and is one-shot',async()=>{
  clock=1000;timers.clear();const s=session();
  const p=s.request(request()); // no UI window needed to create request
  assert.equal(s.list().length,1);
  assert.throws(()=>s.decide({id:'req-1',approved:true,trustedUserGesture:false}),/USER_GESTURE_REQUIRED/);
  assert.equal(s.list().length,1);
  const result=s.decide({id:'req-1',approved:true,trustedUserGesture:true});
  assert.equal(result.approved,true);
  assert.equal((await p).origin,'https://claude.ai');
  assert.equal(s.list().length,0);
  assert.throws(()=>s.decide({id:'req-1',approved:true,trustedUserGesture:true}),/NOT_FOUND/);
});
test('expired request fails without executing command',async()=>{
  clock=1000;timers.clear();const s=session();
  const p=s.request(request('expiry'));
  const timer=[...timers.values()][0];clock=5001;timer();
  await assert.rejects(p,/APPROVAL_EXPIRED/);
  assert.equal(s.list().length,0);
});
test('manual stop cancels all approvals and clears their timers',async()=>{
  clock=1000;timers.clear();const s=session();
  const p=s.request(request('stop'));
  s.stop();
  await assert.rejects(p,/APPROVAL_CANCELLED/);
  assert.equal(timers.size,0);
  assert.deepEqual(s.list(),[]);
});
test('denial rejects without granting control',async()=>{
  clock=1000;timers.clear();const s=session();
  const p=s.request(request('deny'));
  s.decide({id:'deny',approved:false,trustedUserGesture:true});
  await assert.rejects(p,/USER_DENIED/);
});
