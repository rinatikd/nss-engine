import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLocalJobService} from './local_job_service.mjs';

async function fixture(run) {
  const root=await mkdtemp(path.join(tmpdir(),'psdirect-jobs-'));
  const audits=path.join(root,'audits');
  try {await run(root,audits);} finally {await rm(root,{recursive:true,force:true});}
}
const request = workspace => ({requestId:'pr113-safe-test-001',suite:'chrome-pr113-node',workspace});

test('host-approved named suite executes exactly once and redacts outputs',()=>fixture(async(root,audits)=>{
  let started=0;
  const service=createLocalJobService({
    approvedWorkspaceRoots:[root],auditDirectory:audits,
    approveRequest:async ({requestId,planSha256})=>({approved:true,requestId,planSha256}),
    runner:async plan=>{started++;return {
      exitCode:0,stdout:'Bearer sample-secret-token',stderr:'api_key=abc123',truncated:false
    };}
  });
  const first=await service.submit(request(root));
  assert.equal(first.state,'FINISHED');
  assert.equal(first.exitCode,0);
  assert.equal(started,1);
  assert.doesNotMatch(first.stdout,/sample-secret-token/);
  assert.doesNotMatch(first.stderr,/abc123/);
  const next=await service.submit(request(root));
  assert.equal(next.state,'UNKNOWN_PREVIOUS_REQUEST');
  assert.equal(started,1);
  const status=await service.status(request(root).requestId);
  assert.equal(status.state,'FINISHED');
}));

test('local DENY blocks execution independently of model fields',()=>fixture(async(root,audits)=>{
  let started=0;
  const service=createLocalJobService({
    approvedWorkspaceRoots:[root],auditDirectory:audits,
    approveRequest:async()=>({approved:false}),
    runner:async()=>{started++;return {exitCode:0};}
  });
  const r=await service.submit({...request(root),approved:true});
  assert.equal(r.state,'DENIED');
  assert.equal(started,0);
}));

test('host approval with wrong plan fingerprint is rejected',()=>fixture(async(root,audits)=>{
  let started=0;
  const service=createLocalJobService({
    approvedWorkspaceRoots:[root],auditDirectory:audits,
    approveRequest:async({requestId})=>({approved:true,requestId,planSha256:'wrong'}),
    runner:async()=>{started++;return {exitCode:0};}
  });
  const r=await service.submit(request(root));
  assert.equal(r.state,'DENIED');
  assert.equal(started,0);
}));

test('workspace outside allowlist never executes',()=>fixture(async(root,audits)=>{
  const other=await mkdtemp(path.join(tmpdir(),'nonallow-'));
  try {
    let started=0;
    const service=createLocalJobService({
      approvedWorkspaceRoots:[root],auditDirectory:audits,
      approveRequest:async()=>{throw Error('SHOULD_NOT_APPROVE');},
      runner:async()=>{started++;return {exitCode:0};}
    });
    const r=await service.submit(request(other));
    assert.equal(r.state,'UNKNOWN_OR_FAILED');
    assert.equal(r.errorCode,'WORKSPACE_NOT_ALLOWLISTED');
    assert.equal(started,0);
  } finally {await rm(other,{recursive:true,force:true});}
}));

test('crash after claiming does not permit replay',()=>fixture(async(root,audits)=>{
  let invoked=0;
  const service=createLocalJobService({
    approvedWorkspaceRoots:[root],auditDirectory:audits,
    approveRequest:async({requestId,planSha256})=>({approved:true,requestId,planSha256}),
    runner:async()=>{invoked++;throw Error('simulated lost completion');}
  });
  assert.equal((await service.submit(request(root))).state,'UNKNOWN_OR_FAILED');
  assert.equal((await service.submit(request(root))).state,'UNKNOWN_PREVIOUS_REQUEST');
  assert.equal(invoked,1);
}));
