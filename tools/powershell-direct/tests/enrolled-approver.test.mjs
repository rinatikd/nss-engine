import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnrolledApprover} from '../enrolled-approver.mjs';
const sha='a'.repeat(64);
const rule=(overrides={})=>({
 ruleId:'enroll-001',requestId:'test-build-20261115-r1',
 suite:'node-test',workspace:'C:\\Engineering\\Repo',planSha256:sha,
 risk:'code-execution',expiresAt:'2026-11-16T00:00:00.000Z',...overrides
});
const details=r=>({requestId:r.requestId,suite:r.suite,workspace:r.workspace,
 planSha256:r.planSha256,risk:r.risk});

test('no enrollment rejects all requests',()=>{
 assert.deepEqual(createEnrolledApprover().decide(details(rule())),
  {approved:false,reason:'NOT_ENROLLED'});
});

test('only one exact plan and request ID is approved once',()=>{
 const r=rule();const a=createEnrolledApprover({rules:[r],now:()=>Date.parse('2026-11-15T00:00:00Z')});
 assert.equal(a.decide({...details(r),approved:true,extra:'untrusted'}).approved,true);
 assert.equal(a.decide(details(r)).reason,'ENROLLMENT_ALREADY_USED');
});

test('reject plan digest, risk, workspace, suite or request mismatch without consuming allowance',()=>{
 const r=rule();const a=createEnrolledApprover({rules:[r],now:()=>Date.parse('2026-11-15T00:00:00Z')});
 for(const patch of [
  {planSha256:'b'.repeat(64)},{risk:'workspace-write'},
  {workspace:'C:\\Engineering\\Other'},{suite:'git-pull-ff-only'},
  {requestId:'other-request-001'}
 ])assert.equal(a.decide({...details(r),...patch}).approved,false);
 assert.equal(a.decide(details(r)).approved,true);
});

test('reject expired enrollments and unsupported workspace-write rules',()=>{
 const r=rule();
 const a=createEnrolledApprover({rules:[r],now:()=>Date.parse('2026-11-17T00:00:00Z')});
 assert.equal(a.decide(details(r)).reason,'ENROLLMENT_EXPIRED');
 assert.throws(()=>createEnrolledApprover({rules:[rule({risk:'workspace-write'})]}),
 /INVALID_ENROLLMENT/);
});

test('reject model-supplied enrollment and duplicate IDs',()=>{
 assert.throws(()=>createEnrolledApprover({rules:[rule({approved:true})]}),/INVALID_ENROLLMENT/);
 assert.throws(()=>createEnrolledApprover({rules:[rule(),rule({ruleId:'enroll-002'})]}),
 /INVALID_ENROLLMENT/);
});
