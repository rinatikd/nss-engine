import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProviderJournal } from '../server/provider-journal.mjs';

const key=crypto.randomBytes(32);
const identity=(requestId,taskId)=>({
  requestId,taskId,providerId:'claude',tabId:42,
  origin:'https://claude.ai',conversationId:'conversation_001',epoch:7
});
const makeJournal=dir=>new ProviderJournal(dir,{
  hmacKey:key,bridgeEpoch:'bridge_epoch_0001'
});

test('two preloaded journal instances append one monotonic hash chain',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-journal-multi-instance-'));
  try {
    // Both instances load the same empty journal before either one writes.
    const first=makeJournal(dir);
    const second=makeJournal(dir);

    first.outcome(identity('request_0001','task_000001'),'BLOCKED','TEST_FIRST_APPEND');
    second.outcome(identity('request_0002','task_000002'),'BLOCKED','TEST_SECOND_APPEND');

    const records=fs.readFileSync(path.join(dir,'provider-transactions.jsonl'),'utf8')
      .trim().split('\n').map(line=>JSON.parse(line));

    assert.deepEqual(records.map(record=>record.seq),[1,2],
      'sequence numbers must be allocated from the on-disk journal while holding the lock');
    assert.equal(records[1].prevHash,records[0].hash,
      'the second record must extend the first record hash');
    assert.equal(records[1].hash.length,64);

    // A fresh reader must accept the complete chain and see both transactions.
    const reloaded=makeJournal(dir);
    assert.equal(reloaded.status(identity('request_0001','task_000001')).state,'BLOCKED');
    assert.equal(reloaded.status(identity('request_0002','task_000002')).state,'BLOCKED');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('preloaded instances must not both begin an unresolved request on the same tab',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-journal-tab-fence-'));
  try {
    const seed=makeJournal(dir);
    const seedIdentity=identity('request_0001','task_000001');
    seed.beginPrepare(seedIdentity,'a'.repeat(64));
    seed.outcome(seedIdentity,'BLOCKED','TEST_SEED_TERMINAL');

    // Both instances now preload the same epoch and terminal transaction.
    const first=makeJournal(dir);
    const second=makeJournal(dir);
    const one=identity('request_0002','task_000002');
    const two=identity('request_0003','task_000003');
    first.beginPrepare(one,'b'.repeat(64));
    assert.throws(()=>second.beginPrepare(two,'c'.repeat(64)),/PROVIDER_TAB_QUARANTINED/,
      'the second instance must revalidate tab quarantine while holding the journal lock');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('preloaded readers refresh status and events after another instance commits',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-journal-fresh-read-'));
  try {
    const reader=makeJournal(dir);
    const writer=makeJournal(dir);
    const request=identity('request_0004','task_000004');
    writer.beginPrepare(request,'d'.repeat(64));
    const prepared=writer.completePrepare(request,{
      preparedId:'prepared_0004',expiresAt:new Date(Date.now()+60000).toISOString()
    });
    assert.equal(prepared.state,'PREPARED');
    assert.equal(reader.status(request).state,'PREPARED',
      'status must reload committed state while holding the inter-process lock');
    const events=reader.events({after:0,limit:20});
    assert.ok(events.some(event=>event.requestId===request.requestId&&event.state==='PREPARED'),
      'events must include records appended by another preloaded instance');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('constructor fails closed on an existing lock and never removes it',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-journal-stale-lock-'));
  try {
    const writer=makeJournal(dir);
    const request=identity('request_0005','task_000005');
    writer.beginPrepare(request,'e'.repeat(64));
    const journalPath=path.join(dir,'provider-transactions.jsonl');
    const lockPath=journalPath+'.lock';
    const before=fs.readFileSync(journalPath,'utf8');
    fs.writeFileSync(lockPath,'owner=another-process');
    assert.throws(()=>makeJournal(dir),error=>error?.code==='EEXIST');
    assert.equal(fs.readFileSync(journalPath,'utf8'),before,
      'failed recovery must not mutate the journal while another owner holds the lock');
    assert.equal(fs.readFileSync(lockPath,'utf8'),'owner=another-process',
      'constructor must not auto-delete a possibly active or stale lock');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
