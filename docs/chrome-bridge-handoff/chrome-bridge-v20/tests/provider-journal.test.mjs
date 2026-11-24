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
    assert.throws(()=>j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:'0'.repeat(64),payloadHash}),/PROVIDER_FENCING_TOKEN_INVALID/);
    j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash});
    const sent=j.completeCommit(identity,{clickedAt:new Date().toISOString(),clickedSend:true,baseline:0});
    assert.equal(sent.state,'SENT');
    assert.equal(j.status(identity).state,'SENT');
    assert.deepEqual(j.events({after:0,limit:20}).map(x=>x.state),['ACCEPTED','ACCEPTED','PREPARED','DISPATCHED','SENT']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('reply receipt is request-bound, append-only, idempotent and unlocks the tab only after one stable new turn',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    const prepared=j.completePrepare(identity,{preparedId:'prepared_reply_01',expiresAt:new Date(Date.now()+60000).toISOString()});
    j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash});
    const clickedAt=new Date(Date.now()-1000).toISOString();
    j.completeCommit(identity,{clickedAt,clickedSend:true,baseline:4});
    assert.throws(()=>j.beginPrepare({...identity,requestId:'request_0002',taskId:'task_000002'},'c'.repeat(64)),/PROVIDER_TAB_QUARANTINED/);
    const stopped=j.stop(identity);
    assert.equal(stopped.state,'STOP_AFTER_COMMIT');
    assert.equal(stopped.nextEpoch,8);
    assert.throws(()=>j.beginPrepare({...identity,requestId:'request_0002',taskId:'task_000002',epoch:8},'c'.repeat(64)),/PROVIDER_TAB_QUARANTINED/);
    const replySha256=crypto.createHash('sha256').update('synthetic Claude reply','utf8').digest('hex');
    const observedAt=new Date().toISOString();
    const receipt=j.recordReply(identity,{replySha256,replyChars:22,replyIndex:5,observedAt,stableSamples:2});
    assert.equal(receipt.state,'REPLIED');
    assert.equal(receipt.replyReceipt.baseline,4);
    assert.equal(receipt.replyReceipt.replyIndex,5);
    assert.equal(receipt.replyReceipt.replySha256,replySha256);
    assert.equal(receipt.replyReceipt.stableSamples,2);
    assert.ok(receipt.replyReceipt.eventId);
    assert.ok(receipt.replyReceipt.recordHash);
    const duplicate=j.recordReply(identity,{replySha256,replyChars:22,replyIndex:5,observedAt,stableSamples:2});
    assert.equal(duplicate.duplicate,true);
    assert.equal(duplicate.replyReceipt.eventId,receipt.replyReceipt.eventId);
    assert.equal(j.status(identity).replyReceipt.eventId,receipt.replyReceipt.eventId);
    assert.deepEqual(j.events({after:0,limit:30}).slice(-1)[0].state,'REPLIED');
    assert.deepEqual(j.stop(identity),{state:'STOP_AFTER_COMMIT',identity,nextEpoch:8});
    assert.deepEqual(j.beginPrepare({...identity,requestId:'request_0002',taskId:'task_000002',epoch:8},'c'.repeat(64)),{duplicate:false});
    const raw=fs.readFileSync(path.join(dir,'provider-transactions.jsonl'),'utf8');
    assert.equal(raw.includes('synthetic Claude reply'),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('reply receipt rejects wrong identity, missing commit baseline, wrong message index and pre-commit timestamps',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    const prepared=j.completePrepare(identity,{preparedId:'prepared_reply_02',expiresAt:new Date(Date.now()+60000).toISOString()});
    j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash});
    const clickedAt=new Date(Date.now()-1000).toISOString();
    j.completeCommit(identity,{clickedAt,clickedSend:true,baseline:2});
    const common={replySha256:'f'.repeat(64),replyChars:4,replyIndex:3,observedAt:new Date().toISOString(),stableSamples:2};
    assert.throws(()=>j.recordReply({...identity,conversationId:'conversation_other'},common),/PROVIDER_REQUEST_ID_CONFLICT/);
    assert.throws(()=>j.recordReply(identity,{...common,replyIndex:4}),/PROVIDER_REPLY_RECEIPT_INVALID/);
    assert.throws(()=>j.recordReply(identity,{...common,observedAt:new Date(Date.now()-5000).toISOString()}),/PROVIDER_REPLY_RECEIPT_INVALID/);
    assert.throws(()=>j.recordReply(identity,{...common,stableSamples:1}),/PROVIDER_REPLY_RECEIPT_INVALID/);
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
    assert.throws(()=>j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash}),/STALE_FENCING_EPOCH|PROVIDER_PREPARE_NOT_COMMITTABLE/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('revoke during an uncertain commit advances epoch but keeps outcome quarantined',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    const prepared=j.completePrepare(identity,{preparedId:'prepared_0003',expiresAt:new Date(Date.now()+60000).toISOString()});
    j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash});
    const revoked=j.revoke(identity);
    assert.equal(revoked.state,'UNKNOWN');
    assert.equal(revoked.nextEpoch,8);
    assert.ok(revoked.quarantineId);
    assert.throws(()=>j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash}),/STALE_FENCING_EPOCH/);
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
    assert.throws(()=>second.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash}),/PROVIDER_PREPARE_NOT_COMMITTABLE/);
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
    j.beginCommit(identity,{preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash});
    j.completeCommit(identity,{clickedAt:new Date().toISOString(),clickedSend:true,baseline:0});
    const stopped=j.stop(identity);
    assert.equal(stopped.state,'STOP_AFTER_COMMIT');
    assert.equal(stopped.nextEpoch,8);
    assert.equal(j.stop(identity).state,'STOP_AFTER_COMMIT');
    assert.equal(j.status(identity).state,'STOP_AFTER_COMMIT');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('stop cannot attest clean while another request on the same tab remains unknown',()=>{
  const dir=tmp();
  try {
    const j=journal(dir);
    j.beginPrepare(identity,payloadHash);
    j.completePrepare(identity,{preparedId:'prepared_0007',expiresAt:new Date(Date.now()+60000).toISOString()});
    const other={...identity,requestId:'request_0002',taskId:'task_000002'};
    j.outcome(other,'UNKNOWN','SIMULATED_AMBIGUOUS_ACTION');
    const stopped=j.stop(identity);
    assert.equal(stopped.state,'STOP_REQUESTED');
    assert.equal(stopped.nextEpoch,8);
    assert.equal(j.status(other).state,'UNKNOWN');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
