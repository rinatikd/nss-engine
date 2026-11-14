import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDurableEnrolledApprover} from '../durable-enrolled-approver.mjs';

const sha='a'.repeat(64);
const now=()=>Date.parse('2026-11-15T00:00:00.000Z');
const rule=(patch={})=>({
  ruleId:'enroll-001',requestId:'replay-proof-20261115-r1',
  suite:'node-test',workspace:'C:\\Engineering\\Repo',
  planSha256:sha,risk:'code-execution',
  expiresAt:'2026-11-16T00:00:00.000Z',...patch
});
const details=r=>({
 requestId:r.requestId,suite:r.suite,workspace:r.workspace,
 planSha256:r.planSha256,risk:r.risk
});
async function withAudit(action){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'approval-enroll-'));
 try{return await action(directory);}
 finally{await fs.rm(directory,{recursive:true,force:true});}
}

test('durable enrollment survives approver recreation and never replays',async()=>{
 await withAudit(async auditDirectory=>{
  const rules=[rule()];
  const first=createDurableEnrolledApprover({rules,auditDirectory,now});
  assert.equal((await first.decide(details(rules[0]))).approved,true);
  const fresh=createDurableEnrolledApprover({rules,auditDirectory,now});
  assert.equal((await fresh.decide(details(rules[0]))).reason,'ENROLLMENT_ALREADY_USED');
  const files=await fs.readdir(auditDirectory);
  assert.deepEqual(files,['replay-proof-20261115-r1.claim']);
 });
});

test('mismatched plans cannot consume a valid durable enrollment',async()=>{
 await withAudit(async auditDirectory=>{
  const r=rule(),a=createDurableEnrolledApprover({rules:[r],auditDirectory,now});
  assert.equal((await a.decide({...details(r),planSha256:'b'.repeat(64)})).reason,'ENROLLMENT_PLAN_MISMATCH');
  assert.deepEqual(await fs.readdir(auditDirectory),[]);
  assert.equal((await a.decide(details(r))).approved,true);
 });
});

test('missing audit directory and collisions fail closed',async()=>{
 await withAudit(async auditDirectory=>{
  const r=rule(),directory=path.join(auditDirectory,'missing');
  const a=createDurableEnrolledApprover({rules:[r],auditDirectory:directory,now});
  assert.equal((await a.decide(details(r))).reason,'ENROLLMENT_AUDIT_FAILED');
  const b=createDurableEnrolledApprover({rules:[r],auditDirectory,now});
  await fs.writeFile(path.join(auditDirectory,r.requestId+'.claim'),'reserved');
  assert.equal((await b.decide(details(r))).reason,'ENROLLMENT_ALREADY_USED');
 });
});

test('expired rule fails before writing claim',async()=>{
 await withAudit(async auditDirectory=>{
  const r=rule(),a=createDurableEnrolledApprover({
   rules:[r],auditDirectory,now:()=>Date.parse('2026-11-17T00:00:00.000Z')
  });
  assert.equal((await a.decide(details(r))).reason,'ENROLLMENT_EXPIRED');
  assert.deepEqual(await fs.readdir(auditDirectory),[]);
 });
});
