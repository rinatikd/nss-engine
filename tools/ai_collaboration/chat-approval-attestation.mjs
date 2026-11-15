// Experimental fail-closed verifier. NOT wired to live PowerShell Direct.
import {createPublicKey,verify as verifySignature} from 'node:crypto';
const ID=/^[a-zA-Z0-9_-]{8,80}$/;
const HASH=/^[a-f0-9]{64}$/;
const FIELDS=['audience','decision','expiresAt','issuedAt','issuer','nonce','planSha256','requestId','subject','version'];
export function canonicalChatApproval(payload){
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||
    JSON.stringify(Object.keys(payload).sort())!==JSON.stringify(FIELDS.slice().sort()))
   throw Error('APPROVAL_INVALID_PAYLOAD');
 return Buffer.from(JSON.stringify(Object.fromEntries(FIELDS.map(k=>[k,payload[k]]))),'utf8');
}
export function makeChatApprovalVerifier({publicKeyPem,issuer,audience,subject,now=Date.now,replayStore}={}){
 if(typeof publicKeyPem!=='string'||!publicKeyPem.trim()||
    typeof issuer!=='string'||!issuer||typeof audience!=='string'||!audience||
    typeof subject!=='string'||!subject||typeof replayStore?.consumeOnce!=='function')
   throw Error('APPROVAL_VERIFIER_NOT_CONFIGURED');
 const key=createPublicKey(publicKeyPem);
 if(key.asymmetricKeyType!=='ed25519')throw Error('APPROVAL_KEY_TYPE_UNSUPPORTED');
 return async function verifyApproval({payload,signatureBase64Url,expectedRequestId,expectedPlanSha256}){
  const message=canonicalChatApproval(payload);
  const current=now();
  if(payload.version!==1||payload.issuer!==issuer||payload.audience!==audience||
     payload.subject!==subject||payload.decision!=='approve'||
     typeof payload.requestId!=='string'||!ID.test(payload.requestId)||
     typeof payload.nonce!=='string'||!ID.test(payload.nonce)||
     typeof payload.planSha256!=='string'||!HASH.test(payload.planSha256)||
     payload.requestId!==expectedRequestId||payload.planSha256!==expectedPlanSha256||
     !Number.isSafeInteger(payload.issuedAt)||!Number.isSafeInteger(payload.expiresAt)||
     payload.expiresAt<=payload.issuedAt||payload.expiresAt-payload.issuedAt>120000||
     payload.issuedAt>current+5000||payload.expiresAt<=current)
    throw Error('APPROVAL_CLAIMS_INVALID');
  if(typeof signatureBase64Url!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signatureBase64Url))
    throw Error('APPROVAL_SIGNATURE_INVALID');
  const sig=Buffer.from(signatureBase64Url,'base64url');
  if(sig.length!==64||!verifySignature(null,message,key,sig))
    throw Error('APPROVAL_SIGNATURE_INVALID');
  // consumeOnce MUST use durable atomic storage. Never only a process-local Set.
  if(!await replayStore.consumeOnce(payload.issuer+':'+payload.subject+':'+payload.nonce,payload.expiresAt))
    throw Error('APPROVAL_REPLAY_DENIED');
  return Object.freeze({approved:true,requestId:payload.requestId,
    planSha256:payload.planSha256,source:'verified_user_attestation'});
 };
}
