import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {canonicalChatApproval,makeChatApprovalVerifier} from './chat-approval-attestation.mjs';
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const pem=publicKey.export({type:'spki',format:'pem'});
const now=1730000000000,issuer='trusted-host-attestor';
const audience='powershell-direct:engineering-approval',subject='operator-verified-user';
const requestId='engineering_test_1',planSha256='a'.repeat(64);
const payload=(extra={})=>({audience,decision:'approve',expiresAt:now+60000,
 issuedAt:now,issuer,nonce:'nonce_unique_001',planSha256,requestId,subject,version:1,...extra});
const signed=p=>sign(null,canonicalChatApproval(p),privateKey).toString('base64url');
function harness(){
 const used=new Set();
 const verify=makeChatApprovalVerifier({publicKeyPem:pem,issuer,audience,subject,now:()=>now,
  replayStore:{async consumeOnce(key){if(used.has(key))return false;used.add(key);return true;}}});
 return (p,sig=signed(p),hash=planSha256)=>verify({payload:p,signatureBase64Url:sig,
  expectedRequestId:requestId,expectedPlanSha256:hash});
}
test('valid signed approval is bound to a specific plan',async()=>{
 const result=await harness()(payload());
 assert.equal(result.approved,true);
 assert.equal(result.source,'verified_user_attestation');
});
test('same signed nonce cannot be replayed',async()=>{
 const v=harness();await v(payload());
 await assert.rejects(v(payload()),/APPROVAL_REPLAY_DENIED/);
});
test('chat text does not substitute trusted host signature',async()=>{
 await assert.rejects(harness()(payload(),'user_says_approved'),/APPROVAL_SIGNATURE_INVALID/);
});
test('different plan/request cannot reuse approval',async()=>{
 const v=harness();
 await assert.rejects(v(payload(),undefined,'b'.repeat(64)),/APPROVAL_CLAIMS_INVALID/);
 await assert.rejects(v(payload({requestId:'other_request_id'})),/APPROVAL_CLAIMS_INVALID/);
});
test('expiry, denial, future issuance, TTL, issuer mismatches are blocked',async()=>{
 const v=harness();
 for(const x of [{decision:'deny'},{expiresAt:now},{issuedAt:now+10000,expiresAt:now+15000},
   {expiresAt:now+200000},{issuer:'impostor'}])
  await assert.rejects(v(payload(x)),/APPROVAL_CLAIMS_INVALID/);
});
test('unexpected claims and altered signed content are rejected',async()=>{
 const v=harness();
 await assert.rejects(v(payload({approved:true})),/APPROVAL_INVALID_PAYLOAD/);
 await assert.rejects(v(payload({nonce:'another_nonce_1'}),signed(payload())),/APPROVAL_SIGNATURE_INVALID/);
});
test('requires configured trusted key and durable replay interface',()=>{
 assert.throws(()=>makeChatApprovalVerifier({publicKeyPem:pem,issuer,audience,subject}),
  /APPROVAL_VERIFIER_NOT_CONFIGURED/);
});
