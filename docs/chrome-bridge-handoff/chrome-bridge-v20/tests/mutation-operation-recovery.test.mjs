import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {
  installBackgroundCoordinator
} from '../extension/background-coordinator.js';
import {MutationOperationJournal} from '../extension/mutation-operation-journal.js';

if (!globalThis.crypto) globalThis.crypto=webcrypto;

function fixture({failSessionSet=false,probeMutation=null}={}) {
  const data={
    bridgeBackgroundMode:true,
    bridgeConnectionDesired:true,
    bridgeMutationLabMode:true,
    browserToken:'synthetic-browser-token',
    sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}},
    adapters:'{}'
  };
  const session={};
  const listeners=[];
  const local={
    setAccessLevel:async()=>{},
    get:async keys=>keys===null?{...data}:
      Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),
    set:async values=>Object.assign(data,values),
    remove:async key=>{for(const item of (Array.isArray(key)?key:[key]))delete data[item];}
  };
  const sessionStorage={
    setAccessLevel:async()=>{},
    get:async keys=>keys===null?{...session}:
      Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,session[k]])),
    set:async values=>{if(failSessionSet)throw Error('SYNTHETIC_SESSION_WRITE_FAILURE');Object.assign(session,values)},
    remove:async key=>{for(const item of (Array.isArray(key)?key:[key]))delete session[item];}
  };
  const calls=[];
  const chromeApi={
    data,session,calls,listeners,
    storage:{local,session:sessionStorage},
    tabs:{get:async id=>({id,url:'https://claude.ai/chat/conversation_001'})},
    permissions:{contains:async()=>true},
    scripting:{executeScript:async({target,args,func,world})=>{
      if (typeof func==='function' && !Array.isArray(args)) {
        calls.push(['quarantine-probe',target.tabId,world]);
        const raw=probeMutation
          ? await probeMutation({target,tabId:target.tabId,world,calls,data,session})
          : [{result:{
              href:'https://claude.ai/chat/conversation_001',
              origin:'https://claude.ai',lock:null,terminal:null
            }}];
        return raw.map(entry=>({
          ...entry,
          documentId:entry.documentId || target.documentIds?.[0] || 'synthetic-document-'+target.tabId,
          frameId:Number.isInteger(entry.frameId)?entry.frameId:0
        }));
      }
      const [name]=args;
      calls.push(['inject',name,target.tabId]);
      const result=name==='describe'
        ? {tag:'BUTTON',text:'Confirm',href:null,formAction:null}
        : {clicked:true};
      return [{
        documentId:target.documentIds?.[0]||'synthetic-document-'+target.tabId,
        frameId:0,result
      }];
    }},
    runtime:{
      id:'mutation-recovery-test-extension',
      getURL:part=>'chrome-extension://mutation-recovery-test-extension/'+part,
      getContexts:async()=>[],
      sendMessage:async message=>{calls.push(message);return {ok:true};},
      onMessage:{addListener:listener=>listeners.push(listener)}
    },
    offscreen:{createDocument:async()=>{}}
  };
  return chromeApi;
}
function send(chromeApi,type,payload={},page='control.html') {
  const listener=chromeApi.listeners.at(-1);
  return new Promise(resolve=>{
    let responded=false;
    const handled=listener({
      target:'bridge-coordinator',type,...payload
    },{
      id:chromeApi.runtime.id,url:chromeApi.runtime.getURL(page)
    },value=>{responded=true;resolve(value);});
    if (!handled && !responded) resolve(undefined);
  });
}
function journal(chromeApi,id) {
  return new MutationOperationJournal(chromeApi,{uuid:()=>id});
}

test('replacement MV3 worker recovers interrupted injection before Grant and blocks the affected tab',async()=>{
  const chromeApi=fixture();
  const store=journal(chromeApi,'operation_recovery_0001');
  const op=await store.begin({
    command:'browser_click',tabId:79001,origin:'https://claude.ai',
    url:'https://claude.ai/chat/conversation_001',
    documentId:'document-main-0001',frameId:0
  });
  await store.markInjecting(op.operationId,{documentId:'document-main-0001',frameId:0});

  installBackgroundCoordinator(chromeApi);
  const grant=await send(chromeApi,'grant-background-control',{
    tabId:79001,durationMinutes:15,localGesture:true
  });
  assert.deepEqual(chromeApi.data.bridgeMutationQuarantinedTabs,[79001]);

  assert.equal(grant.error,'TAB_MUTATION_QUARANTINED');
  assert.equal(chromeApi.session.bridgeBackgroundControlGrants,undefined);

  const records=await store.list();
  assert.deepEqual(records[0].events.map(event=>event.phase),
    ['ACCEPTED','INJECTING','UNKNOWN']);
});

test('a successful generic click is quarantined before its completion is acknowledged',async()=>{
  const chromeApi=fixture();
  const tabId=79003;
  chromeApi.session.bridgeBackgroundControlGrants={
    [String(tabId)]:{origin:'https://claude.ai',expires:Date.now()+120000}
  };
  installBackgroundCoordinator(chromeApi);

  const mutation=send(chromeApi,'dispatch',{
    command:{
      name:'browser_click',expires:Date.now()+90000,
      args:{tabId,selector:'button.confirm'}
    }
  },'transport-host.html');

  let pending=[];
  for(let i=0;i<40;i++){
    const state=await send(chromeApi,'approval-list');
    pending=state?.pending||[];
    if(pending.some(item=>item.tabId===tabId))break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(pending.length,1);
  const approval=await send(chromeApi,'approval-decide',{
    id:pending[0].id,approved:true,trustedUserGesture:true
  });
  assert.equal(approval.approved,true);
  const response=await mutation;
  const result=response?.result??response;
  assert.equal(result.clicked,true);
  assert.equal(result.mutationQuarantined,true);
  assert.deepEqual(chromeApi.data.bridgeMutationQuarantinedTabs,[tabId]);
  assert.deepEqual(chromeApi.session.bridgeBackgroundControlGrants,{});
  assert.deepEqual(chromeApi.calls.filter(call=>call[0]==='inject').map(call=>call[1]),
    ['describe','describe','browser_click']);

  // There is no site-side-effect completion receipt for a generic click.
  // The next operation on this exact tab must therefore be denied.
  const grant=await send(chromeApi,'grant-background-control',{
    tabId,durationMinutes:15,localGesture:true
  });
  assert.equal(grant.error,'TAB_MUTATION_QUARANTINED');
});

test('failed tab-grant revoke after generic action returns UNKNOWN and persists global quarantine lock',async()=>{
  const chromeApi=fixture({failSessionSet:true});
  const tabId=79004;
  chromeApi.session.bridgeBackgroundControlGrants={
    [String(tabId)]:{origin:'https://claude.ai',expires:Date.now()+120000}
  };
  installBackgroundCoordinator(chromeApi);
  const mutation=send(chromeApi,'dispatch',{
    command:{
      name:'browser_click',expires:Date.now()+90000,
      args:{tabId,selector:'button.confirm'}
    }
  },'transport-host.html');

  let pending=[];
  for(let i=0;i<40;i++){
    const state=await send(chromeApi,'approval-list');
    pending=state?.pending||[];
    if(pending.some(item=>item.tabId===tabId))break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(pending.length,1);
  const approved=await send(chromeApi,'approval-decide',{
    id:pending[0].id,approved:true,trustedUserGesture:true
  });
  assert.equal(approved.approved,true);

  const response=await mutation;
  assert.equal(response.dispatchState,'UNKNOWN');
  assert.equal(response.error,'MUTATION_QUARANTINE_GRANT_REVOKE_FAILED');
  assert.deepEqual(chromeApi.data.bridgeMutationQuarantinedTabs,[tabId]);
  assert.equal(chromeApi.data.bridgeMutationQuarantineLock,true);
  assert.deepEqual(chromeApi.calls.filter(call=>call[0]==='inject').map(call=>call[1]),
    ['describe','describe','browser_click']);
});

test('per-tab Revoke preserves quarantine for a completed generic click without side-effect proof',async()=>{
  const chromeApi=fixture();
  const store=journal(chromeApi,'operation_generic_0001');
  const op=await store.begin({
    command:'browser_click',tabId:79002,origin:'https://claude.ai',
    url:'https://claude.ai/chat/conversation_001',
    documentId:'document-main-0002',frameId:0
  });
  await store.markInjecting(op.operationId,{documentId:'document-main-0002',frameId:0});
  await store.complete(op.operationId,{outcome:'CLICKED',sideEffect:'generic-page-action'});

  installBackgroundCoordinator(chromeApi);
  const result=await send(chromeApi,'revoke-background-control',{tabId:79002});
  assert.equal(result.ok,true);
  assert.deepEqual(chromeApi.data.bridgeMutationQuarantinedTabs,[79002]);

  // Even with the Lab flag restored in this disposable fixture, durable
  // quarantine still denies a new Grant for the affected tab.
  chromeApi.data.bridgeMutationLabMode=true;
  const grant=await send(chromeApi,'grant-background-control',{
    tabId:79002,durationMinutes:15,localGesture:true
  });
  assert.equal(grant.error,'TAB_MUTATION_QUARANTINED');
  assert.deepEqual(chromeApi.session.bridgeBackgroundControlGrants,{});
});

test('replacement MV3 worker rehydrates provider quarantine with the original document binding and exact-document proof',async()=>{
  const tabId=79005;
  const documentId='document-provider-recovery-79005';
  const requestId='r4request79005';
  const payloadHash='a'.repeat(64);
  const preparedId='prepared_79005';
  let probedDocumentId='replacement-document-79005';
  const chromeApi=fixture({probeMutation:async()=>[{
    result:{
      href:'https://claude.ai/chat/conversation_001',
      origin:'https://claude.ai',lock:null,
      terminal:{
        schemaVersion:1,requestId,command:'provider_commit',
        origin:'https://claude.ai',conversationId:'conversation_001',
        startedAt:injectionStartedAt,completedAt:Date.now(),
        state:'COMMIT_CLICK_ATTEMPTED',clickAttempted:true,clickReturned:true,
        payloadHash,preparedId
      }
    },
    documentId:probedDocumentId,frameId:0
  }]});
  const store=journal(chromeApi,'operation_provider_recovery_0005');
  const operation=await store.begin({
    command:'provider_commit',tabId,origin:'https://claude.ai',
    url:'https://claude.ai/chat/conversation_001',documentId,frameId:0,
    conversationId:'conversation_001',requestId,taskId:'task_79005',
    providerId:'claude',preparedId,payloadHash,epoch:1
  });
  await store.markInjecting(operation.operationId,{documentId,frameId:0});
  // Read the write-ahead record to obtain its authoritative INJECTING timestamp.
  const beforeRecovery=await store.list();
  const journalRecord=beforeRecovery.find(item=>item.operationId===operation.operationId);
  const injectionStartedAt=journalRecord.events.find(event=>event.phase==='INJECTING').at;
  await new Promise(resolve=>setTimeout(resolve,3));
  chromeApi.session.bridgeBackgroundControlGrants={
    [String(tabId)]:{origin:'https://claude.ai',expires:Date.now()+60000}
  };

  installBackgroundCoordinator(chromeApi);
  let status=null;
  for (let attempt=0;attempt<100;attempt++) {
    status=await send(chromeApi,'quarantine-status');
    if (status?.records?.some(item=>item.tabId===tabId)) break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(status.available,true);
  assert.equal(status.records.length,1);
  const record=status.records[0];
  assert.equal(record.reconcilable,true);
  assert.equal(record.operationId,operation.operationId);
  assert.equal(record.documentId,documentId);
  assert.equal(record.requestId,requestId);
  assert.equal(record.command,'provider_commit');
  assert.equal(record.startedAt,injectionStartedAt);

  const wrongDocument=await send(chromeApi,'reconcile-quarantine',{
    tabId,token:record.token,confirmed:true,localGesture:true
  });
  assert.equal(wrongDocument.ok,false);
  assert.equal(wrongDocument.error,'QUARANTINE_DOCUMENT_IDENTITY_CHANGED');
  assert.deepEqual(chromeApi.data.bridgeMutationQuarantinedTabs,[tabId]);
  assert.ok(chromeApi.session.bridgeBackgroundControlGrants[String(tabId)],
    'a stale/replacement document must not revoke or unlock the quarantined scope');

  probedDocumentId=documentId;
  const reconciled=await send(chromeApi,'reconcile-quarantine',{
    tabId,token:record.token,confirmed:true,localGesture:true
  });
  assert.equal(reconciled.ok,true);
  assert.equal(reconciled.operationId,operation.operationId);
  assert.equal(reconciled.deliveryState,'UNKNOWN');
  assert.match(reconciled.warning,/DO_NOT_REPLAY/);
  assert.deepEqual(chromeApi.data.bridgeMutationQuarantinedTabs,[]);
  assert.equal(chromeApi.session.bridgeBackgroundControlGrants[String(tabId)],undefined);
  assert.equal(chromeApi.data.bridgeMutationQuarantineRecords[String(tabId)],undefined);
  assert.equal(chromeApi.data.bridgeMutationQuarantineAudit.at(-1).operationId,operation.operationId);
  assert.equal(chromeApi.data.bridgeMutationQuarantineAudit.at(-1).trustBoundary,
    'LOCAL_MACHINE_TRUSTED_CONTROL_UI');
});

test('multiple unresolved journal operations on one tab stay non-reconcilable',async()=>{
  const tabId=79006;
  const documentId='document-provider-multiple-79006';
  // Both journals share one Chrome storage area in the test fixture.
  const chromeApi=fixture();
  const firstStore=journal(chromeApi,'operation_provider_multiple_0006a');
  const secondStore=journal(chromeApi,'operation_provider_multiple_0006b');
  const base={
    command:'provider_commit',tabId,origin:'https://claude.ai',
    url:'https://claude.ai/chat/conversation_001',documentId,frameId:0,
    conversationId:'conversation_001',providerId:'claude',epoch:1
  };
  const first=await firstStore.begin({
    ...base,requestId:'r4request79006a',taskId:'task_79006a',
    preparedId:'prepared_79006a',payloadHash:'b'.repeat(64)
  });
  await firstStore.markInjecting(first.operationId,{documentId,frameId:0});
  const second=await secondStore.begin({
    ...base,requestId:'r4request79006b',taskId:'task_79006b',
    preparedId:'prepared_79006b',payloadHash:'c'.repeat(64)
  });
  await secondStore.markInjecting(second.operationId,{documentId,frameId:0});

  installBackgroundCoordinator(chromeApi);
  let status=null;
  for(let attempt=0;attempt<100;attempt++){
    status=await send(chromeApi,'quarantine-status');
    if(status?.records?.some(item=>item.tabId===tabId))break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(status.available,true);
  const record=status.records.find(item=>item.tabId===tabId);
  assert.ok(record);
  assert.equal(record.reconcilable,false);
  assert.equal(record.reasonCode,'MULTIPLE_UNRESOLVED_OPERATIONS');
  assert.equal(chromeApi.data.bridgeMutationQuarantinedTabs.includes(tabId),true);
});

test('replacement MV3 worker honors exact durable reconciliation audit and does not re-quarantine UNKNOWN history',async()=>{
  const chromeApi=fixture();
  const tabId=79007;
  const operationId='operation_provider_reconciled_0007';
  const requestId='r4request79007';
  const documentId='document-provider-reconciled-79007';
  const payloadHash='f'.repeat(64);
  const preparedId='prepared_79007';
  const store=journal(chromeApi,operationId);
  const operation=await store.begin({
    command:'provider_commit',tabId,origin:'https://claude.ai',
    url:'https://claude.ai/chat/conversation_001',documentId,frameId:0,
    conversationId:'conversation_001',requestId,taskId:'task_79007',
    providerId:'claude',preparedId,payloadHash,epoch:1
  });
  await store.markInjecting(operation.operationId,{documentId,frameId:0});
  await store.unknown(operation.operationId,{
    code:'WORKER_RESTART_DURING_INJECTION',
    sideEffect:'operation-result-unverified'
  });

  const audit={
    schemaVersion:1,eventId:'reconcile-event-79007',
    type:'OPERATOR_RECONCILE',tabId,quarantineToken:'reconciled-qtoken-79007',
    operationId,requestId,command:'provider_commit',origin:'https://claude.ai',
    conversationId:'conversation_001',
    trustBoundary:'LOCAL_MACHINE_TRUSTED_CONTROL_UI',
    evidence:{terminalState:'COMMIT_CLICK_ATTEMPTED',documentId,frameId:0},
    backgroundGrantRevokedAndVerified:true,sessionAuthorizationAbsent:true,
    confirmed:true,localGesture:true,reconciledAt:Date.now()
  };
  chromeApi.data.bridgeMutationQuarantineAudit=[audit];
  chromeApi.session.bridgeMutationQuarantineAudit=[audit];

  installBackgroundCoordinator(chromeApi);
  const response=await send(chromeApi,'dispatch',{
    command:{
      name:'browser_click',expires:Date.now()+60000,
      args:{tabId,selector:'button.confirm'}
    }
  },'transport-host.html');
  assert.ok(response && response.error,
    'the new mutation is denied because no per-tab Control Grant exists');
  assert.notEqual(response.error,'TAB_MUTATION_QUARANTINED',
    'a previously reconciled operation must not recreate its old quarantine');
  assert.deepEqual(chromeApi.data.bridgeMutationQuarantinedTabs||[],[]);
  assert.equal(chromeApi.data.bridgeMutationQuarantineRecords,undefined);
  assert.equal(chromeApi.session.bridgeMutationQuarantinedTabs,undefined);
  assert.equal(chromeApi.session.bridgeMutationQuarantineRecords,undefined);
  assert.equal(chromeApi.calls.filter(call=>call[0]==='inject').length,0,
    'the new operation must never reach page injection without a Grant');
  const status=await send(chromeApi,'quarantine-status');
  assert.equal(status.records.length,0);
  const history=await store.list();
  assert.deepEqual(history[0].events.map(event=>event.phase),
    ['ACCEPTED','INJECTING','UNKNOWN'],
    'audit acknowledgement must not rewrite or erase immutable UNKNOWN journal history');
});
