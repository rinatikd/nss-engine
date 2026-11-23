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
    auditDirectory:audits,
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

test('workspace selection is per-job and does not require a persistent directory list',()=>fixture(async(root,audits)=>{
  const other=await mkdtemp(path.join(tmpdir(),'nonallow-'));
  try {
    let started=0,approvedWorkspace='';
    const service=createLocalJobService({
      auditDirectory:audits,
      approveRequest:async({requestId,planSha256,workspace})=>{
        approvedWorkspace=workspace;
        return {approved:true,requestId,planSha256};
      },
      runner:async()=>{started++;return {exitCode:0};}
    });
    const r=await service.submit(request(other));
    assert.equal(r.state,'FINISHED');
    assert.equal(approvedWorkspace,other);
    assert.equal(started,1);
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

test('durable audit inbox survives service recreation without replay rights',()=>fixture(async(root,audits)=>{
  let executions=0;
  const settings={
    approvedWorkspaceRoots:[root],auditDirectory:audits,
    approveRequest:async()=>({approved:false,reason:'APPROVAL_EXPIRED'}),
    runner:async()=>{executions++;return {exitCode:0};}
  };
  const first=createLocalJobService(settings);
  const result=await first.submit(request(root));
  assert.equal(result.state,'DENIED');
  const second=createLocalJobService(settings);
  const rows=await second.recent();
  assert.equal(rows.length,1);
  assert.equal(rows[0].requestId,request(root).requestId);
  assert.equal(rows[0].state,'DENIED');
  assert.equal(rows[0].reason,'APPROVAL_EXPIRED');
  assert.equal('stdout' in rows[0],false);
  assert.equal('command' in rows[0],false);
  assert.equal('workspace' in rows[0],false);
  assert.equal((await second.submit(request(root))).state,'UNKNOWN_PREVIOUS_REQUEST');
  assert.equal(executions,0);
}));

test('interrupted audit entries display manual review, never active approval',()=>fixture(async(root,audits)=>{
  const {mkdir,writeFile}=await import('node:fs/promises');
  await mkdir(audits,{recursive:true});
  await writeFile(path.join(audits,'stalejob123.json'),JSON.stringify({
    requestId:'stalejob123',suite:'node-test',state:'PENDING_LOCAL_APPROVAL',
    createdAt:'2026-11-15T05:00:00.000Z',planSha256:'f'.repeat(64)
  }));
  const service=createLocalJobService({    auditDirectory:audits,approveRequest:async()=>{throw Error('SHOULD_NOT_APPROVE');}});
  const rows=await service.recent();
  assert.equal(rows[0].state,'REQUIRES_MANUAL_REVIEW');
  assert.equal((await service.submit({requestId:'stalejob123',suite:'chrome-pr113-node',workspace:root})).state,
    'UNKNOWN_PREVIOUS_REQUEST');
  await assert.rejects(()=>service.recent(999),/INVALID_RECENT_LIMIT/);
}));
