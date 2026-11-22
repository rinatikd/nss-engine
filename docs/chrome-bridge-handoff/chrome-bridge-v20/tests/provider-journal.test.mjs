import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProviderJournal, validateProviderIdentity } from '../server/provider-journal.mjs';
import { verifyQuiescence } from '../server/provider-transport-crypto.mjs';

const key=crypto.randomBytes(32);
const identity={
  requestId:'request_0001',taskId:'task_000001',providerId:'claude',
  tabId:42,origin:'https://claude.ai',conversationId:'conversation_001',epoch:7
};
const payloadHash='a'.repeat(64);
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'provider-journal-'));
const journal=(dir,opts={})=>new ProviderJournal(dir,{hmacKey:key,bridgeEpoch:'bridge_epoch_0001',...opts});

test('provider journal validates identity and persists prepare/commit transitions',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    assert.deepEqual(validateProviderIdentity(identity),identity);
    assert.deepEqual(j.beginPrepare(identity,payloadHash),{duplicate:false});
    const prepared=j.completePrepare(identity,{preparedId:'prepared_0001',expiresAt:new Date(Date.now()+60000).toISOString()});
    assert.equal(prepared.state,'PREPARED');
    assert.equal(prepared.clickedSend,false);
    assert.equal(j.status(identity).state,'PREPARED');
    assert.equal(j.beginPrepare(identity,payloadHash).duplicate,true);
    assert.equal(j.beginPrepare(identity,payloadHash).fencingToken,prepared.fencingToken);
    assert.throws(()=>j.beginPrepare(identity,'b'.repeat(64)),/PROVIDER_REQUEST_ID_CONFLICT/);
    assert.throws(()=>j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:'0'.repeat(64)}),/PROVIDER_FENCING_TOKEN_INVALID/);
    j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken});
    const sent=j.completeCommit(identity,{clickedAt:new Date().toISOString(),clickedSend:true});
    assert.equal(sent.state,'SENT');
    assert.equal(j.status(identity).state,'SENT');
    assert.deepEqual(j.events({after:0,limit:20}).map(x=>x.state),['ACCEPTED','ACCEPTED','PREPARED','DISPATCHED','SENT']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('clean stop revokes prepared token, advances epoch and returns verifiable proof',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    const prepared=j.completePrepare(identity,{preparedId:'prepared_0002',expiresAt:new Date(Date.now()+60000).toISOString()});
    const stopped=j.stop(identity);
    assert.equal(stopped.state,'STOPPED_CLEAN');
    assert.equal(stopped.nextEpoch,8);
    assert.equal(stopped.quiescence.unresolved,0);
    assert.equal(stopped.quiescence.outstandingPrepared,0);
    assert.equal(verifyQuiescence(stopped.quiescence,identity,key),true);
    assert.equal(j.stop(identity).state,'STOPPED_CLEAN');
    assert.throws(()=>j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken}),/STALE_FENCING_EPOCH|PROVIDER_PREPARE_NOT_COMMITTABLE/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('revoke during an uncertain commit advances epoch but keeps outcome quarantined',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    const prepared=j.completePrepare(identity,{preparedId:'prepared_0003',expiresAt:new Date(Date.now()+60000).toISOString()});
    j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken});
    const revoked=j.revoke(identity);
    assert.equal(revoked.state,'UNKNOWN');
    assert.equal(revoked.nextEpoch,8);
    assert.ok(revoked.quarantineId);
    assert.throws(()=>j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken}),/STALE_FENCING_EPOCH/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('restart converts PREPARED to UNKNOWN and never replays the old fencing token',()=>{
  const dir=tmp();
  try {
    const first=journal(dir,{bridgeEpoch:'bridge_epoch_0001'});
    first.beginPrepare(identity,payloadHash);
    const prepared=first.completePrepare(identity,{preparedId:'prepared_0004',expiresAt:new Date(Date.now()+60000).toISOString()});
    const second=journal(dir,{bridgeEpoch:'bridge_epoch_0002'});
    const status=second.status(identity);
    assert.equal(status.state,'UNKNOWN');
    assert.ok(status.quarantineId);
    assert.equal(second.beginPrepare(identity,payloadHash).transaction.state,'UNKNOWN');
    assert.throws(()=>second.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken}),/PROVIDER_PREPARE_NOT_COMMITTABLE/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('tampered journal fails closed',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    const file=path.join(dir,'provider-transactions.jsonl');
    const raw=fs.readFileSync(file,'utf8').replace('prepare.started','prepare.tampered');
    fs.writeFileSync(file,raw);
    assert.throws(()=>journal(dir),/PROVIDER_JOURNAL_CORRUPT_FAIL_CLOSED/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('one unresolved or prepared transaction quarantines the tab against a new request ID',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    j.completePrepare(identity,{preparedId:'prepared_0005',expiresAt:new Date(Date.now()+60000).toISOString()});
    const next={...identity,requestId:'request_0002'};
    assert.throws(()=>j.beginPrepare(next,'c'.repeat(64)),/PROVIDER_TAB_QUARANTINED/);
    const stopped=j.stop(identity);
    assert.equal(stopped.state,'STOPPED_CLEAN');
    assert.deepEqual(j.beginPrepare({...next,epoch:8},'c'.repeat(64)),{duplicate:false});
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('stop after a confirmed commit advances the epoch without claiming cancellation',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    const prepared=j.completePrepare(identity,{preparedId:'prepared_0006',expiresAt:new Date(Date.now()+60000).toISOString()});
    j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken});
    j.completeCommit(identity,{clickedAt:new Date().toISOString(),clickedSend:true});
    const stopped=j.stop(identity);
    assert.equal(stopped.state,'STOP_AFTER_COMMIT');
    assert.equal(stopped.nextEpoch,8);
    assert.equal(j.stop(identity).state,'STOP_AFTER_COMMIT');
    assert.equal(j.status(identity).state,'STOP_AFTER_COMMIT');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
