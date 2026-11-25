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
