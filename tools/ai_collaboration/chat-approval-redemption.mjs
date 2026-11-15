// Host-confirmed approval redemption contract — NOT registered in live service.
// This module cannot mint attestation or execute an OS command.
// The authorization sink MUST atomically transition exactly the pending plan.
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[a-zA-Z0-9_-]{8,80}$/;
export function makeApprovalRedemption({verifyAttestation,getPending,authorizePending}={}){
 if(typeof verifyAttestation!=='function'||typeof getPending!=='function'||
    typeof authorizePending!=='function')throw Error('REDEMPTION_NOT_CONFIGURED');
 return async function redeem({requestId,planSha256,attestation}={}){
  if(typeof requestId!=='string'||!ID.test(requestId)||
     typeof planSha256!=='string'||!HASH.test(planSha256)||
     !attestation||typeof attestation!=='object')
   throw Error('REDEMPTION_INVALID_ARGUMENTS');
  const pending=await getPending(requestId);
  if(!pending||pending.state!=='PENDING_LOCAL_APPROVAL'||
     pending.requestId!==requestId||pending.planSha256!==planSha256)
   throw Error('REDEMPTION_PENDING_PLAN_NOT_FOUND');
  // Authenticated attestation from outside this model is mandatory.
  // verifyAttestation must check signature, user, nonce, TTL and consume
  // a durable replay key BEFORE calling authorizePending.
  const grant=await verifyAttestation({
   ...attestation,expectedRequestId:requestId,expectedPlanSha256:planSha256
  });
  if(grant?.approved!==true||grant.requestId!==requestId||
     grant.planSha256!==planSha256||grant.source!=='verified_user_attestation')
   throw Error('REDEMPTION_UNVERIFIED_GRANT');
  // Must be a compare-and-swap in host-owned durable pending-job storage.
  // A returned false may be expiry, cancellation, already consumed or changed plan.
  const accepted=await authorizePending({
    requestId,planSha256,source:'verified_user_attestation'
  });
  if(accepted!==true)throw Error('REDEMPTION_ATOMIC_CLAIM_FAILED');
  return Object.freeze({requestId,planSha256,state:'APPROVED_FOR_EXISTING_RUNNER'});
 };
}
