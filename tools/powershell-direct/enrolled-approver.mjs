// In-memory authorization from explicitly operator-enrolled, trusted local policy.
// Rules MUST be provided by local supervisor configuration, never from MCP arguments.
// Does not replace host consent or prove it occurred. No rules = fail closed.
const ID=/^[a-zA-Z0-9_-]{8,80}$/;
const SHA=/^[a-f0-9]{64}$/;
const RISKS=new Set(['read','code-execution']);
const EXACT_KEYS=['ruleId','requestId','suite','workspace','planSha256','risk','expiresAt'];
const fail=x=>{throw Error(x);};
const validIso=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(Date.parse(s)).toISOString()===s;
const strict=o=>o&&typeof o==='object'&&!Array.isArray(o);

export function createEnrolledApprover({rules=[],now=Date.now}={}){
 if(!Array.isArray(rules)||rules.length>100||typeof now!=='function')fail('INVALID_ENROLLMENT');
 const enrolled=new Map();
 for(const rule of rules){
  if(!strict(rule)||Object.keys(rule).sort().join('|')!==[...EXACT_KEYS].sort().join('|')||
     typeof rule.ruleId!=='string'||!ID.test(rule.ruleId)||
     typeof rule.requestId!=='string'||!ID.test(rule.requestId)||
     typeof rule.suite!=='string'||!ID.test(rule.suite)||
     typeof rule.workspace!=='string'||!rule.workspace||
     typeof rule.planSha256!=='string'||!SHA.test(rule.planSha256)||
     !RISKS.has(rule.risk)||!validIso(rule.expiresAt)||
     enrolled.has(rule.requestId))fail('INVALID_ENROLLMENT');
  // Never allow a remotely selected request to gain write-workspace authority.
  // Each enrollment authorizes one *specific request ID and plan digest*, once.
  enrolled.set(rule.requestId,Object.freeze({...rule}));
 }
 const consumed=new Set();
 return Object.freeze({
  decide(details){
   if(!strict(details)||typeof details.requestId!=='string')return {approved:false,reason:'NOT_ENROLLED'};
   const rule=enrolled.get(details.requestId);
   if(!rule)return {approved:false,reason:'NOT_ENROLLED'};
   if(consumed.has(rule.requestId))return {approved:false,reason:'ENROLLMENT_ALREADY_USED'};
   if(now()>Date.parse(rule.expiresAt))return {approved:false,reason:'ENROLLMENT_EXPIRED'};
   if(details.planSha256!==rule.planSha256||details.suite!==rule.suite||
      details.workspace!==rule.workspace||details.risk!==rule.risk)
    return {approved:false,reason:'ENROLLMENT_PLAN_MISMATCH'};
   // Mark consumed synchronously before releasing a valid approval.
   consumed.add(rule.requestId);
   return {approved:true,requestId:rule.requestId,planSha256:rule.planSha256,reason:'OPERATOR_ENROLLED'};
  }
 });
}
