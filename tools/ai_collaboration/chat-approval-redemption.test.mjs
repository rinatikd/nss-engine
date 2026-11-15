import test from 'node:test';
import assert from 'node:assert/strict';
import {makeApprovalRedemption} from './chat-approval-redemption.mjs';
const requestId='engineering_test_20261115',planSha256='f'.repeat(64);
const identity={requestId,planSha256,source:'verified_user_attestation',approved:true};
function fixture({state='PENDING_LOCAL_APPROVAL',grant=identity,accept=true}={}){
 let claimCount=0,verifyCount=0,readCount=0;
 const pending={requestId,planSha256,state};
 const redeem=makeApprovalRedemption({
   getPending:async()=>{readCount++;return {...pending};},
   verifyAttestation:async()=>{verifyCount++;return grant;},
   authorizePending:async()=>{claimCount++;if(!accept||pending.state!=='PENDING_LOCAL_APPROVAL')return false;pending.state='APPROVED';return true;}
 });
 return {redeem,counts:()=>({readCount,verifyCount,claimCount})};
}
const req={requestId,planSha256,attestation:{payload:'opaque'}};
test('valid grant and same pending plan claimed once',async()=>{
 const f=fixture();assert.equal((await f.redeem(req)).state,'APPROVED_FOR_EXISTING_RUNNER');
 await assert.rejects(f.redeem(req),/REDEMPTION_PENDING_PLAN_NOT_FOUND/);
 assert.deepEqual(f.counts(),{readCount:2,verifyCount:1,claimCount:1});
});
test('no matching pending state never reaches signature verification',async()=>{
 const f=fixture({state:'DENIED'});
 await assert.rejects(f.redeem(req),/REDEMPTION_PENDING_PLAN_NOT_FOUND/);
 assert.equal(f.counts().verifyCount,0);
});
test('unverified, model-authorized and mismatched grants denied',async()=>{
 for(const grant of [
  {...identity,approved:false},
  {...identity,source:'chat_text'},
  {...identity,planSha256:'e'.repeat(64)}
 ]){
  const f=fixture({grant});
  await assert.rejects(f.redeem(req),/REDEMPTION_UNVERIFIED_GRANT/);
  assert.equal(f.counts().claimCount,0);
 }
});
test('invalid request and plan hash never trigger pending read',async()=>{
 const f=fixture();
 await assert.rejects(f.redeem({...req,planSha256:'invalid'}),/REDEMPTION_INVALID_ARGUMENTS/);
 assert.equal(f.counts().readCount,0);
});
test('atomic claim failure denies execution',async()=>{
 const f=fixture({accept:false});
 await assert.rejects(f.redeem(req),/REDEMPTION_ATOMIC_CLAIM_FAILED/);
 assert.equal(f.counts().claimCount,1);
});
test('no verification or atomic sink fails construction',()=>{
 assert.throws(()=>makeApprovalRedemption({getPending:async()=>{}}),/REDEMPTION_NOT_CONFIGURED/);
});
