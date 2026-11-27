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
test('per-tab cancellation rejects only matching approvals and clears their timers',async()=>{
  clock=1000;timers.clear();const s=session();
  const first=s.request({...request('tab-7'),tabId:7});
  const second=s.request({...request('tab-8'),tabId:8});
  assert.equal(s.cancelTab(7),1);
  await assert.rejects(first,/APPROVAL_CANCELLED/);
  assert.equal(timers.size,1);
  assert.deepEqual(s.list().map(x=>x.id),['tab-8']);
  s.decide({id:'tab-8',approved:false,trustedUserGesture:true});
  await assert.rejects(second,/USER_DENIED/);
  assert.equal(timers.size,0);
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

test('unexpected registration exception is sanitized before a waiter is scheduled',()=>{
  clock=1000;timers.clear();const s=session();
  s.broker.request=()=>{throw Error('untrusted tab metadata');};
  assert.throws(()=>s.request(request('registration')),/APPROVAL_REGISTRATION_FAILED/);
  assert.equal(s.waiters.size,0);
  assert.equal(s.list().length,0);
});
test('waiter scheduling failure clears pending approval without allowing a send',async()=>{
  clock=1000;timers.clear();
  const s=new ApprovalSession({now:()=>clock,setTimeoutImpl:()=>{throw Error('untrusted scheduling detail');}});
  await assert.rejects(s.request(request('schedule')),/APPROVAL_SESSION_FAILED/);
  assert.equal(s.list().length,0);
  assert.equal(s.waiters.size,0);
});
test('known broker validation code remains explicit',()=>{
  clock=1000;timers.clear();const s=session();
  assert.throws(()=>s.request({...request('invalid'),expires:clock-1}),/INVALID_APPROVAL_EXPIRY/);
  assert.equal(s.list().length,0);
});
