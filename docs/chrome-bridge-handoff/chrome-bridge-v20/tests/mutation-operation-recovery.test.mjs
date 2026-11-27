import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {
  installBackgroundCoordinator
} from '../extension/background-coordinator.js';
import {MutationOperationJournal} from '../extension/mutation-operation-journal.js';

if (!globalThis.crypto) globalThis.crypto=webcrypto;

function fixture({failSessionSet=false}={}) {
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
    scripting:{executeScript:async({target,args})=>{
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

