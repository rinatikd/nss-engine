import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {MutationOperationJournal} from '../extension/mutation-operation-journal.js';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
function fixture({failSet=false,failGet=false}={}) {
  const data={};
  const calls=[];
  const local={
    setAccessLevel:async options=>calls.push(['access',options.accessLevel]),
    get:async key=>{
      if(failGet) throw Error('SYNTHETIC_READ_FAILURE');
      if(key===null)return {...data};
      if(Array.isArray(key))return Object.fromEntries(key.map(k=>[k,data[k]]));
      return {[key]:data[key]};
    },
    set:async value=>{
      calls.push(['set',Object.keys(value)]);
      if(failSet) throw Error('SYNTHETIC_WRITE_FAILURE');
      Object.assign(data,value);
    }
  };
  return {api:{storage:{local}},data,calls};
}
const identity=(overrides={})=>({
  command:'browser_click',tabId:42,origin:'https://claude.ai',
  url:'https://claude.ai/chat/conversation_001',documentId:'document-0000000001',
  frameId:0,conversationId:'conversation_001',...overrides
});
const journalFor=(f,id='operation_00000001')=>new MutationOperationJournal(f.api,{
  now:(()=>{let t=1000;return()=>++t;})(),uuid:()=>id
});

test('write-ahead record stores bounded identity metadata, never selector or message data',async()=>{
  const f=fixture(),journal=journalFor(f);
  const record=await journal.begin(identity({
    requestId:'request_00000001',taskId:'task_00000001',providerId:'claude',
    preparedId:'prepared_000001',payloadHash:'a'.repeat(64),epoch:3
  }));
  assert.equal(record.events[0].phase,'ACCEPTED');
  assert.equal(record.documentId,'document-0000000001');
  const persisted=f.data['bridgeMutationOperation.v1.operation_00000001'];
  assert.ok(persisted);
  const text=JSON.stringify(persisted);
  for(const secret of ['selector','message','prompt','Hello world','api_key='])
    assert.equal(text.includes(secret),false);
  assert.equal(persisted.payloadHash,'a'.repeat(64));
  assert.ok(/^[a-f0-9]{64}$/.test(persisted.events[0].hash));
});

test('phase transition is ordered and hash chained through COMPLETED',async()=>{
  const f=fixture(),journal=journalFor(f);
  const record=await journal.begin(identity());
  await journal.markInjecting(record.operationId,{documentId:'document-0000000001',frameId:0});
  await journal.complete(record.operationId,{outcome:'CLICKED',sideEffect:'generic-page-action'});
  const [stored]=await journal.list();
  assert.deepEqual(stored.events.map(event=>event.phase),['ACCEPTED','INJECTING','COMPLETED']);
  assert.equal(stored.events[1].prevHash,stored.events[0].hash);
  assert.equal(stored.events[2].prevHash,stored.events[1].hash);
});

test('pre-injection failure is a terminal NOT_PERFORMED record',async()=>{
  const f=fixture(),journal=journalFor(f);
  const record=await journal.begin(identity());
  await journal.abortBeforeInjection(record.operationId,{code:'USER_DENIED'});
  const [stored]=await journal.list();
  assert.equal(stored.events.at(-1).phase,'ABORTED_BEFORE_INJECTION');
  assert.equal(stored.events.at(-1).outcome,'NOT_PERFORMED');
});

test('a proven pre-side-effect cancellation is terminal and does not quarantine on recovery',async()=>{
  const f=fixture(),journal=journalFor(f);
  const record=await journal.begin(identity());
  await journal.markInjecting(record.operationId,{documentId:'document-0000000001',frameId:0});
  await journal.cancelledBeforeSideEffect(record.operationId,{
    code:'MUTATION_CANCELLED_BEFORE_SIDE_EFFECT',documentId:'document-0000000001'
  });
  const [stored]=await journal.list();
  assert.deepEqual(stored.events.map(event=>event.phase),
    ['ACCEPTED','INJECTING','CANCELLED_BEFORE_SIDE_EFFECT']);
  assert.equal(stored.events.at(-1).outcome,'NOT_PERFORMED');
  assert.equal(stored.events.at(-1).sideEffect,'none');
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.deepEqual(recovered.quarantinedTabs,[]);
  assert.deepEqual(recovered.unresolved,[]);
});

test('recovery aborts ACCEPTED but quarantines every interrupted INJECTING operation',async()=>{
  const f=fixture();
  let next=0;
  const journal=new MutationOperationJournal(f.api,{uuid:()=> 'operation_0000000'+(++next)});
  const accepted=await journal.begin(identity({tabId:41}));
  const injecting=await journal.begin(identity({tabId:42}));
  await journal.markInjecting(injecting.operationId,{documentId:'document-0000000001'});
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.equal(recovered.corrupt,false);
  assert.deepEqual(recovered.quarantinedTabs,[42]);
  assert.equal(recovered.unresolved.length,1);
  assert.equal(recovered.unresolved[0].operationId,injecting.operationId);
  const records=await journal.list();
  assert.equal(records.find(x=>x.operationId===accepted.operationId).events.at(-1).phase,'ABORTED_BEFORE_INJECTION');
  assert.equal(records.find(x=>x.operationId===injecting.operationId).events.at(-1).phase,'UNKNOWN');
});

test('recovery keeps an existing UNKNOWN operation quarantined and never deletes journal history',async()=>{
  const f=fixture(),journal=journalFor(f);
  const record=await journal.begin(identity());
  await journal.markInjecting(record.operationId,{documentId:'document-0000000001'});
  await journal.unknown(record.operationId,{code:'DOCUMENT_BOUND_INJECTION_FAILED'});
  const before=Object.keys(f.data).length;
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.deepEqual(recovered.quarantinedTabs,[42]);
  assert.equal(Object.keys(f.data).length,before);
});

test('an unverified unsent composer draft remains quarantined after worker recovery',async()=>{
  const f=fixture(),journal=journalFor(f);
  const record=await journal.begin(identity({command:'provider_prepare'}));
  await journal.markInjecting(record.operationId,{documentId:'document-0000000001'});
  await journal.complete(record.operationId,{
    outcome:'NOT_PERFORMED',sideEffect:'composer-draft-state-unverified',
    code:'PROVIDER_PREPARE_TEXT_MISMATCH'
  });
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.deepEqual(recovered.quarantinedTabs,[42]);
  assert.equal(recovered.unresolved.length,1);
  assert.equal(recovered.unresolved[0].phase,'DRAFT_UNVERIFIED');
  assert.equal(recovered.unresolved[0].reasonCode,'PROVIDER_PREPARE_TEXT_MISMATCH');
});

test('generic click completion is not mistaken for site-side-effect quiescence',async()=>{
  const f=fixture(),journal=journalFor(f);
  const record=await journal.begin(identity({command:'browser_click'}));
  await journal.markInjecting(record.operationId,{documentId:'document-0000000001'});
  await journal.complete(record.operationId,{
    outcome:'CLICKED',sideEffect:'generic-page-action'
  });
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.deepEqual(recovered.quarantinedTabs,[42]);
  assert.equal(recovered.unresolved.length,1);
  assert.equal(recovered.unresolved[0].phase,'SIDE_EFFECT_UNVERIFIED');
  assert.equal(recovered.unresolved[0].reasonCode,'GENERIC_PAGE_SIDE_EFFECT_UNVERIFIED');
});

test('illegal phase transition is denied and no second mutation attempt is written',async()=>{
  const f=fixture(),journal=journalFor(f);
  const record=await journal.begin(identity());
  await journal.abortBeforeInjection(record.operationId);
  await assert.rejects(journal.markInjecting(record.operationId,{documentId:'document-0000000001'}),
    /MUTATION_OPERATION_TRANSITION_DENIED/);
});

test('journal capacity exhaustion fails closed before accepting another operation',async()=>{
  const f=fixture();
  for(let i=0;i<5000;i++) f.data['bridgeMutationOperation.v1.seed_'+i]={};
  const journal=journalFor(f);
  await assert.rejects(journal.begin(identity()),/MUTATION_OPERATION_JOURNAL_CAPACITY_EXCEEDED/);
  assert.equal(Object.keys(f.data).filter(key=>key.startsWith('bridgeMutationOperation.v1.')).length,5000);
});

test('local storage failure prevents a write-ahead record from being accepted',async()=>{
  const f=fixture({failSet:true}),journal=journalFor(f);
  await assert.rejects(journal.begin(identity()),/MUTATION_OPERATION_JOURNAL_WRITE_FAILED/);
});

test('local storage read failure never turns missing evidence into safe recovery',async()=>{
  const f=fixture({failGet:true}),journal=journalFor(f);
  await assert.rejects(journal.recover(),/MUTATION_OPERATION_JOURNAL_UNAVAILABLE/);
});

test('deleting an operation record is detected by the global journal index',async()=>{
  const f=fixture(),journal=journalFor(f);
  await journal.begin(identity());
  delete f.data['bridgeMutationOperation.v1.operation_00000001'];
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.equal(recovered.corrupt,true);
  await assert.rejects(new MutationOperationJournal(f.api).begin(identity()),
    /MUTATION_OPERATION_JOURNAL_CORRUPT/);
});

test('deleting the global index while operation records remain fails closed',async()=>{
  const f=fixture(),journal=journalFor(f);
  await journal.begin(identity());
  delete f.data['bridgeMutationOperation.v1.index'];
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.equal(recovered.corrupt,true);
});

test('a record without an indexed operation identity is treated as an orphan',async()=>{
  const f=fixture();
  f.data['bridgeMutationOperation.v1.orphan_0000001']={schemaVersion:1};
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.equal(recovered.corrupt,true);
});

test('unexpected record fields and updatedAt changes fail exact schema validation',async()=>{
  const f=fixture(),journal=journalFor(f);
  await journal.begin(identity());
  const key='bridgeMutationOperation.v1.operation_00000001';
  f.data[key].unexpectedPrompt='must-not-be-persisted';
  let recovered=await new MutationOperationJournal(f.api).recover();
  assert.equal(recovered.corrupt,true);

  delete f.data[key].unexpectedPrompt;
  f.data[key].updatedAt=0;
  recovered=await new MutationOperationJournal(f.api).recover();
  assert.equal(recovered.corrupt,true);
});

test('unexpected global index fields fail closed',async()=>{
  const f=fixture(),journal=journalFor(f);
  await journal.begin(identity());
  f.data['bridgeMutationOperation.v1.index'].unexpected='tampered';
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.equal(recovered.corrupt,true);
});

test('tampering with immutable tab/document identity breaks the journal chain',async()=>{
  const f=fixture(),journal=journalFor(f);
  await journal.begin(identity());
  const key='bridgeMutationOperation.v1.operation_00000001';
  f.data[key].tabId=999;
  const recovered=await new MutationOperationJournal(f.api).recover();
  assert.equal(recovered.corrupt,true);
  assert.deepEqual(recovered.quarantinedTabs,[]);
});

test('tampered record/hash chain fails closed',async()=>{
  const f=fixture(),journal=journalFor(f);
  await journal.begin(identity());
  f.data['bridgeMutationOperation.v1.operation_00000001'].events[0].phase='INJECTING';
  const recovered=await journal.recover();
  assert.equal(recovered.corrupt,true);
  assert.deepEqual(recovered.quarantinedTabs,[]);
});
