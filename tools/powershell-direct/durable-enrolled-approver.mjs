// Persistent one-use gate for operator-enrolled exact plans.
// Requires an operator-provisioned private directory. No directory creation,
// policy modification, or access through MCP. Fail closed on all I/O errors.
import {open,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createEnrolledApprover} from './enrolled-approver.mjs';

const fail=reason=>{throw Error(reason);};
export function createDurableEnrolledApprover({rules=[],auditDirectory,now=Date.now}={}){
 if(typeof auditDirectory!=='string'||!path.isAbsolute(auditDirectory)||
    typeof now!=='function')fail('PRIVATE_AUDIT_DIRECTORY_REQUIRED');
 const memory=createEnrolledApprover({rules,now});
 const usedRoot=path.resolve(auditDirectory);
 return Object.freeze({
  async decide(details){
   const decision=memory.decide(details);
   if(decision.approved!==true)return decision;
   let handle;
   try{
    const info=await lstat(usedRoot);
    if(!info.isDirectory()||info.isSymbolicLink()||
       path.resolve(await realpath(usedRoot))!==usedRoot)
      return {approved:false,reason:'AUDIT_DIRECTORY_UNTRUSTED'};
    // A unique, non-overwritable persistent claim is created before execution.
    // A crash before running intentionally consumes approval: no auto-retry.
    const claim=path.join(usedRoot,decision.requestId+'.claim');
    handle=await open(claim,'wx',0o600);
    const proof={
      requestId:decision.requestId,planSha256:decision.planSha256,
      consumedAt:new Date(now()).toISOString()
    };
    await handle.writeFile(JSON.stringify(proof));
    await handle.sync();
    await handle.close();
    handle=null;
    return decision;
   }catch(e){
    return {approved:false,reason:e?.code==='EEXIST'?
      'ENROLLMENT_ALREADY_USED':'ENROLLMENT_AUDIT_FAILED'};
   }finally{
    if(handle)await handle.close().catch(()=>{});
   }
  }
 });
}
