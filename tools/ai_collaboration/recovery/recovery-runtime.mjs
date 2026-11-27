// A Windows-only, explicit, bounded recovery executor. No user-supplied
// commands, binary paths, or startup arguments from an MCP request.
// This module does not itself start anything when imported.
// Process identity and health probes MUST be implemented by the trusted host.
import { recoveryPlan, validateRecoveryProfile } from './recovery-plan.mjs';

export class RecoveryBlocked extends Error {}

export function makeRecoveryExecutor({
  profile, probe, start, authorize, journal,
  now = Date.now, settleMs = 12000
}) {
  validateRecoveryProfile(profile);
  for (const [name, fn] of Object.entries({probe,start,authorize,journal})) {
    if (typeof fn !== 'function') throw Error('MISSING_'+name.toUpperCase());
  }
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 60000)
    throw Error('INVALID_SETTLE_TIME');
  let inFlight = null;
  async function observations() {
    const out={};
    for (const item of profile.services) {
      try {
        const o=await probe(item.id);
        out[item.id]={state:o?.state ?? 'unknown'};
      } catch {out[item.id]={state:'unknown'};}
    }
    return out;
  }
  return {
    async inspect() {
      const state=await observations();
      return {state,plan:recoveryPlan(profile,state,{requested:false})};
    },
    async recover({requestId,operatorGesture=false}={}) {
      if(inFlight) return {state:'BUSY',requestId};
      if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))
        throw new RecoveryBlocked('INVALID_REQUEST_ID');
      if(!operatorGesture) throw new RecoveryBlocked('LOCAL_OPERATOR_GESTURE_REQUIRED');
      // One in-process operation at a time; persistent request claims
      // must additionally be enforced by journal before any spawn.
      inFlight=requestId;
      try {
        const claim=await journal({type:'claim',requestId,at:now()});
        if(claim?.claimed!==true)
          return {state:'DUPLICATE_OR_UNCERTAIN',requestId};
        const before=await observations();
        const plan=recoveryPlan(profile,before,{requested:true});
        const approved=await authorize({requestId,plan});
        if(approved?.approved!==true||approved.requestId!==requestId){
          await journal({type:'denied',requestId});
          return {state:'DENIED',requestId,plan};
        }
        const outcomes={...plan.outcomes};
        // Probe AGAIN after approval and before EACH start; a process may have
        // appeared in the meantime. Never kill it or start a duplicate.
        for(const item of plan.actions){
          const service=profile.services.find(s=>s.id===item.id);
          const deps=service.after;
          if(deps.some(d=>!['ALREADY_HEALTHY','HEALTHY_AFTER_START'].includes(outcomes[d]))){
            outcomes[item.id]='BLOCKED_DEPENDENCY';continue;
          }
          const current=await probe(item.id).catch(()=>({state:'unknown'}));
          if(current.state==='healthy') {
            outcomes[item.id]='ALREADY_HEALTHY';continue;
          }
          if(current.state!=='stopped') {
            outcomes[item.id]='BLOCKED_'+String(current.state).toUpperCase();continue;
          }
          // No execute if the durable journal cannot record imminent dispatch.
          const record=await journal({type:'dispatch',requestId,serviceId:item.id});
          if(record?.recorded!==true){
            outcomes[item.id]='BLOCKED_JOURNAL';continue;
          }
          try {
            await start(item.id);
            // This must check owning PID plus per-service authenticated health,
            // not just HTTP 404/405 or TCP LISTEN.
            const verified=await probe(item.id);
            outcomes[item.id]=verified.state==='healthy'?
              'HEALTHY_AFTER_START':'START_UNCONFIRMED';
          } catch {
            outcomes[item.id]='START_UNKNOWN';
          }
          await journal({type:'result',requestId,serviceId:item.id,
            outcome:outcomes[item.id]});
        }
        await journal({type:'finished',requestId,outcomes});
        return {state:'FINISHED',requestId,outcomes};
      } finally {
        inFlight=null;
      }
    }
  };
}
