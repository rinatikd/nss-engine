import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startBackgroundTransport, stopBackgroundTransport, installBackgroundCoordinator} from '../extension/background-coordinator.js';

function fakeChrome(data={},options={}) {
  const listeners=[];
  const calls=[];
  const session={};
  let blockedGrantWrite=false;
  return {
    calls,listeners,data,session,
    storage:{local:{
      setAccessLevel:async opts=>calls.push(['restrict',opts.accessLevel]),
      get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),
      set:async next=>{
        const failedKey=Object.keys(next).find(key=>
          options.failLocalSet===true || options.failLocalSet===key ||
          (Array.isArray(options.failLocalSet) && options.failLocalSet.includes(key)));
        if (failedKey) throw Error('SYNTHETIC_LOCAL_STORAGE_WRITE_FAILED:'+failedKey);
        Object.assign(data,next);calls.push(['set',next]);
      }
    },session:{
      setAccessLevel:async opts=>calls.push(['session-restrict',opts.accessLevel]),
      get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,session[k]])),
      set:async next=>{
        const failedKey=Object.keys(next).find(key=>
          options.failSessionSet===true || options.failSessionSet===key ||
          (Array.isArray(options.failSessionSet) && options.failSessionSet.includes(key)));
        if (failedKey) throw Error('SYNTHETIC_SESSION_STORAGE_WRITE_FAILED:'+failedKey);
        if (Object.hasOwn(next,'bridgeBackgroundControlGrants') && options.failGrantStoreWrite)
          throw Error('SYNTHETIC_GRANT_STORE_WRITE_FAILED');
        if (Object.hasOwn(next,'bridgeBackgroundControlGrants') &&
            options.beforeGrantStoreWrite && !blockedGrantWrite) {
          blockedGrantWrite=true;
          await options.beforeGrantStoreWrite(next,session,calls);
        }
        Object.assign(session,next);
        calls.push(['session-set',next]);
      },
      remove:async key=>{if(options.failSessionRemove===key)throw Error('SYNTHETIC_SESSION_REMOVE_FAILED');delete session[key];}
    }},
    tabs:{get:async id=>({id,url:'https://claude.ai/chat/conversation_001'})},
    permissions:{contains:async()=>true},
    scripting:{executeScript:async({target,args,world})=>{
      const [name,details,origin]=args;
      calls.push(['script',name,target.tabId]);
      const raw=options.executeScript
        ? await options.executeScript({name,details,origin,tabId:target.tabId,session,data,calls,target,world})
        : name==='agent_context' ? [{result:{
            verified:true,origin:'https://claude.ai',conversationId:'conversation_001'
          }}]
          : name==='provider_prepare' ? [{result:{
              prepared:true,clickedSend:false,requestId:details.requestId,
              preparedId:details.preparedId,payloadHash:details.payloadHash,
              sideEffect:'composer-filled-no-send'
            }}]
            : name==='provider_commit' ? [{result:{
                clickedSend:true,requestId:details.requestId,preparedId:details.preparedId,
                payloadHash:details.payloadHash,clickedAt:new Date().toISOString()
              }}]
              : [{result:{ok:true}}];
      return raw.map(entry=>({
        ...entry,
        documentId:entry.documentId || target.documentIds?.[0] || 'fake-document-'+target.tabId,
        frameId:Number.isInteger(entry.frameId)?entry.frameId:0
      }));
    }},
    runtime:{
      id:'ext-mock-id',
      getURL:part=>'chrome-extension://ext-mock-id/'+part,
      getContexts:async()=>[],
      sendMessage:async msg=>{calls.push(['message',msg.type]);return {ok:true};},
      onMessage:{addListener:l=>listeners.push(l)}
    },
    offscreen:{createDocument:async opts=>calls.push(['create',opts.reasons[0]])}
  };
}
test('feature gate refuses to open offscreen document unless desired and opted in',async()=>{
  const c=fakeChrome({bridgeBackgroundMode:false,bridgeConnectionDesired:true,browserToken:'S'});
  const result=await startBackgroundTransport(c);
  assert.equal(result.reason,'BACKGROUND_MODE_DISABLED');
  assert.equal(c.calls.filter(x=>x[0]==='create').length,0);
});
test('manual disconnect stays off even with saved token and opted-in lab',async()=>{
  const c=fakeChrome({bridgeBackgroundMode:true,bridgeConnectionDesired:false,browserToken:'S'});
  const result=await startBackgroundTransport(c);
  assert.equal(result.reason,'MANUAL_DISCONNECT');
  assert.equal(c.calls.filter(x=>x[0]==='create').length,0);
});
test('background start restricts storage before reading and creates offscreen host',async()=>{
  const c=fakeChrome({bridgeBackgroundMode:true,bridgeConnectionDesired:true,browserToken:'S'});
  const result=await startBackgroundTransport(c);
  assert.equal(result.ok,true);
  assert.deepEqual(c.calls.map(x=>x[0]),['restrict','create','message']);
});
test('manual Stop supersedes a start that is waiting for offscreen host creation',async()=>{
  const c=fakeChrome({bridgeBackgroundMode:true,bridgeConnectionDesired:true,browserToken:'S'});
  let releaseCreation;
  let markCreationStarted;
  const creationStarted=new Promise(resolve=>{markCreationStarted=resolve;});
  const holdCreation=new Promise(resolve=>{releaseCreation=resolve;});
  c.offscreen.createDocument=async opts=>{
    c.calls.push(['create',opts.reasons[0]]);
    markCreationStarted();
    await holdCreation;
  };

  const pendingStart=startBackgroundTransport(c);
  await creationStarted;
  await stopBackgroundTransport(c);
  releaseCreation();

  const result=await pendingStart;
  assert.equal(result.ok,false);
  assert.equal(result.reason,'START_SUPERSEDED');
  const messages=c.calls.filter(x=>x[0]==='message').map(x=>x[1]);
  assert.deepEqual(messages,['stop'],'a late START must never be delivered after manual Stop');
});

test('content scripts cannot spoof coordinator status or dispatch',async()=>{
  const c=fakeChrome();
  installBackgroundCoordinator(c);
  assert.equal(c.listeners.length,1);
  const msg={target:'bridge-coordinator',type:'transport-status',status:{connected:true,state:'connected'}};
  let response;
  const invoke=(m,s)=>c.listeners[0](m,s,x=>{response=x;});
  assert.equal(invoke(msg,{id:c.runtime.id,tab:{id:17}}),false);
  assert.equal(response,undefined);
  assert.equal(invoke(msg,{id:c.runtime.id,url:'chrome-extension://ext-mock-id/control.html'}),false);
  assert.deepEqual(response,{ok:false});
  invoke({target:'bridge-coordinator',type:'status'},{id:c.runtime.id,url:'chrome-extension://ext-mock-id/control.html'});
  assert.equal(response.connected,false);
  invoke(msg,{id:c.runtime.id,url:c.runtime.getURL('transport-host.html')});
  assert.deepEqual(response,{ok:true});
  invoke({target:'bridge-coordinator',type:'status'},{id:c.runtime.id,url:'chrome-extension://ext-mock-id/control.html'});
  assert.equal(response.connected,true);
});

test('extension control window may have sender.tab and still receive coordinator status',()=>{
  const c=fakeChrome();
  installBackgroundCoordinator(c);
  const sender={id:c.runtime.id,url:c.runtime.getURL('control.html'),tab:{id:456}};
  let response;
  const handled=c.listeners[0]({target:'bridge-coordinator',type:'status'},sender,x=>response=x);
  assert.equal(handled,false);
  // Coordinator state is module-scoped and may have been set by an earlier
  // test; this test asserts delivery to a real extension control tab.
  assert.equal(typeof response.state,'string');
  assert.equal(typeof response.connected,'boolean');
  response=undefined;
  c.listeners[0]({target:'bridge-coordinator',type:'approval-list'},sender,x=>response=x);
  assert.deepEqual(response,{pending:[]});
});
test('background-control-status returns profile flags and effective per-tab grants to control page only',async()=>{
  const data={
    bridgeBackgroundMode:true,
    bridgeMutationLabMode:true,
    bridgeConnectionDesired:true,
    sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}}
  };
  const c=fakeChrome(data);
  await c.storage.session.set({bridgeBackgroundControlGrants:{
    '42':{origin:'https://claude.ai',expires:Date.now()+60000}
  }});
  installBackgroundCoordinator(c);
  const sender={id:c.runtime.id,url:c.runtime.getURL('control.html'),tab:{id:456}};
  const response=await new Promise(resolve=>{
    const handled=c.listeners[0]({target:'bridge-coordinator',type:'background-control-status'},sender,resolve);
    assert.equal(handled,true);
  });
  assert.equal(response.available,true);
  assert.equal(response.backgroundMode,true);
  assert.equal(response.mutationEnabled,true);
  assert.equal(response.connectionDesired,true);
  assert.equal(response.grantsKnown,true);
  assert.equal(response.activeCount,1);
  assert.deepEqual(response.grants.map(x=>({tabId:x.tabId,origin:x.origin})),[
    {tabId:42,origin:'https://claude.ai'}
  ]);

  let deniedResponse;
  const handled=c.listeners[0](
    {target:'bridge-coordinator',type:'background-control-status'},
    {id:c.runtime.id,url:'https://claude.ai/chat/test',tab:{id:42}},
    value=>{deniedResponse=value;}
  );
  assert.equal(handled,false);
  assert.equal(deniedResponse,undefined);
});

test('extension ID match alone does not authorize web content scripts or other extension pages',()=>{
  const c=fakeChrome();
  installBackgroundCoordinator(c);
  const cases=[
    {id:c.runtime.id,url:'https://claude.ai/chat/x',tab:{id:456}},
    {id:c.runtime.id,url:c.runtime.getURL('other.html'),tab:{id:456}},
    {id:'other-extension-id',url:c.runtime.getURL('control.html'),tab:{id:456}},
    {id:c.runtime.id,url:c.runtime.getURL('transport-host.html'),tab:{id:456}}
  ];
  for (const sender of cases) {
    let response;
    const handled=c.listeners[0]({target:'bridge-coordinator',type:'status'},sender,x=>response=x);
    assert.equal(handled,false);
    assert.equal(response,undefined);
  }
});


const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const LAB_STATE={
  bridgeBackgroundMode:true,
  bridgeConnectionDesired:true,
  bridgeMutationLabMode:true,
  browserToken:'synthetic-browser-token',
  sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}},
  adapters:'{}'
};
function sessionLease(overrides={}) {
  const now=Date.now();
  return {
    schemaVersion:1,
    sessionId:'session_0001',
    bridgeEpoch:'bridge_epoch_0001',
    issuedAt:now-100,
    expiresAt:now+120000,
    origins:['https://claude.ai'],
    capabilities:['agent_send','provider_prepare','provider_commit'],
    approvalMode:'chat-owner-approved',
    status:'active',
    ...overrides
  };
}
function providerPrepare(tabId) {
  return {
    name:'provider_prepare',
    bridgeEpoch:'bridge_epoch_0001',
    expires:Date.now()+90000,
    args:{
      requestId:'request_0001',
      taskId:'task_000001',
      providerId:'claude',
      tabId,
      origin:'https://claude.ai',
      conversationId:'conversation_001',
      epoch:1,
      message:'safe synthetic coordinator test',
      payloadHash:'a'.repeat(64),
      preparedId:'prepared_0001',
      expiresAt:new Date(Date.now()+60000).toISOString()
    }
  };
}
function sendCoordinator(c,type,payload={},page='control.html') {
  return sendCoordinatorTo(c,c.listeners.at(-1),type,payload,page);
}
function sendCoordinatorTo(c,listener,type,payload={},page='control.html') {
  return new Promise(resolve=>{
    let called=false;
    const handled=listener({
      target:'bridge-coordinator',type,...payload
    },{
      id:c.runtime.id,url:c.runtime.getURL(page)
    },value=>{called=true;resolve(value);});
    if (!handled && !called) resolve(undefined);
  });
}
async function prepareLab(c,tabId) {
  await startBackgroundTransport(c);
  c.session.bridgeSessionAuthorization=sessionLease();
  c.data.bridgeConnectionDesired=true;
  c.data.bridgeMutationLabMode=true;
  installBackgroundCoordinator(c);
  return tabId;
}

test('per-tab Revoke clears only the storage copy whose fence write was confirmed',async()=>{
  for (const [failedStore,options] of [
    ['local',{failLocalSet:'bridgeMutationRevokingTabs'}],
    ['session',{failSessionSet:'bridgeMutationRevokingTabs'}]
  ]) {
    const c=fakeChrome({...LAB_STATE},options);
    await prepareLab(c,72);
    c.session.bridgeBackgroundControlGrants={'72':{
      origin:'https://claude.ai',expires:Date.now()+60000
    }};
    const result=await sendCoordinator(c,'revoke-background-control',{tabId:72});
    assert.equal(result.ok,true,'a single confirmed durable fence remains sufficient when the other store rejects writes ('+failedStore+')');
    assert.equal(c.data.bridgeMutationRevokingTabs,undefined);
    assert.equal(c.session.bridgeMutationRevokingTabs,undefined);
    assert.equal(c.session.bridgeBackgroundControlGrants?.['72'],undefined);
  }
});

test('Stop fences a running provider_prepare and waits for its page action before confirming',async()=>{
  let enteredResolve,releaseResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const held=new Promise(resolve=>{releaseResolve=resolve;});
  const c=fakeChrome({...LAB_STATE},{executeScript:async({name,details,origin,tabId,calls})=>{
    calls.push(['script',name,tabId]);
    if (name==='agent_context') return [{result:{
      verified:true,origin:'https://claude.ai',conversationId:'conversation_001'
    }}];
    if (name==='provider_prepare') {
      enteredResolve();
      await held;
      calls.push(['page-action-completed',tabId]);
      return [{result:{
        prepared:true,clickedSend:false,requestId:details.requestId,
        preparedId:details.preparedId,payloadHash:details.payloadHash,
        sideEffect:'composer-filled-no-send'
      }}];
    }
    return [{result:{ok:true}}];
  }});
  await prepareLab(c,42);

  const mutation=sendCoordinator(c,'dispatch',{command:providerPrepare(42)},'transport-host.html');
  await entered;
  let stopDone=false;
  const stop=sendCoordinator(c,'stop-background').then(result=>{
    stopDone=true;return result;
  });
  await delay(25);
  assert.equal(stopDone,false,'Stop must not acknowledge while the accepted page action is still running');

  releaseResolve();
  const dispatchResult=await mutation;
  const stopResult=await stop;
  assert.equal(dispatchResult.result.prepared,true);
  assert.equal(stopResult.ok,true);
  const completedIndex=c.calls.findIndex(x=>x[0]==='page-action-completed');
  const stopMessageIndex=c.calls.findIndex(x=>x[0]==='message'&&x[1]==='stop');
  assert.ok(completedIndex>=0 && stopMessageIndex>completedIndex,
    'the offscreen Stop acknowledgement must follow the accepted page action');
  assert.equal(c.data.bridgeConnectionDesired,false);
  assert.equal(c.data.bridgeMutationLabMode,false);
  assert.equal(c.session.bridgeSessionAuthorization,undefined);
});

test('Stop timeout returns UNKNOWN and persists tab quarantine; a later Start cannot reopen that tab',async()=>{
  let enteredResolve,releaseResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const held=new Promise(resolve=>{releaseResolve=resolve;});
  const c=fakeChrome({...LAB_STATE},{executeScript:async({name,details,origin,tabId,calls})=>{
    calls.push(['script',name,tabId]);
    if (name==='agent_context') return [{result:{
      verified:true,origin:'https://claude.ai',conversationId:'conversation_001'
    }}];
    if (name==='provider_prepare') {
      enteredResolve();
      await held;
      return [{result:{
        prepared:true,clickedSend:false,requestId:details.requestId,
        preparedId:details.preparedId,payloadHash:details.payloadHash,
        sideEffect:'composer-filled-no-send'
      }}];
    }
    return [{result:{ok:true}}];
  }});
  await startBackgroundTransport(c);
  c.session.bridgeSessionAuthorization=sessionLease();
  installBackgroundCoordinator(c,{stopDrainTimeoutMs:25,startDrainTimeoutMs:25});

  const mutation=sendCoordinator(c,'dispatch',{command:providerPrepare(43)},'transport-host.html');
  await entered;
  const stop=await sendCoordinator(c,'stop-background');
  assert.equal(stop.ok,false);
  assert.equal(stop.reason,'BACKGROUND_STOP_UNCONFIRMED');
  assert.equal(stop.outcome,'UNKNOWN');
  assert.deepEqual(stop.quarantinedTabs,[43]);
  assert.deepEqual(c.data.bridgeMutationQuarantinedTabs,[43]);

  releaseResolve();
  await mutation;
  c.data.bridgeConnectionDesired=true;
  c.data.bridgeMutationLabMode=true;
  await assert.rejects(
    startBackgroundTransport(c),
    /MUTATION_QUARANTINE_STATE_UNAVAILABLE/,
    'an UNKNOWN global Stop must leave a durable lock that blocks reconnect'
  );
  assert.equal(c.data.bridgeMutationQuarantineLock,true);
  const before=c.calls.filter(x=>x[0]==='script').length;
  const retry=await sendCoordinator(c,'dispatch',{command:providerPrepare(43)},'transport-host.html');
  assert.equal(retry.error,'BACKGROUND_STOP_IN_PROGRESS');
  assert.equal(retry.dispatchState,'NOT_PERFORMED');
  assert.equal(c.calls.filter(x=>x[0]==='script').length,before,
    'unknown Stop must not permit another DOM/page action');
});

test('Revoke is a synchronous per-tab fence and its grant-store write follows an accepted Grant',async()=>{
  let grantWriteEntered,releaseGrantWrite;
  const entered=new Promise(resolve=>{grantWriteEntered=resolve;});
  const held=new Promise(resolve=>{releaseGrantWrite=resolve;});
  const c=fakeChrome({...LAB_STATE},{beforeGrantStoreWrite:async()=>{
    grantWriteEntered();
    await held;
  }});
  await startBackgroundTransport(c);
  installBackgroundCoordinator(c);

  const grant=sendCoordinator(c,'grant-background-control',{
    tabId:44,durationMinutes:60,localGesture:true
  });
  await entered;
  const revoke=sendCoordinator(c,'revoke-background-control',{tabId:44});
  await delay(5);
  const racingGrant=await sendCoordinator(c,'grant-background-control',{
    tabId:44,durationMinutes:60,localGesture:true
  });
  assert.equal(racingGrant.error,'TAB_CONTROL_REVOKING');

  releaseGrantWrite();
  const grantResult=await grant;
  const revokeResult=await revoke;
  assert.equal(grantResult.tabId,44);
  assert.equal(revokeResult.ok,true);
  assert.equal(c.session.bridgeBackgroundControlGrants?.['44'],undefined,
    'Revoke must be the last writer after the accepted Grant');
});


test('replacement worker blocks a new Grant while a durable per-tab Revoke fence exists',async()=>{
  const c=fakeChrome({...LAB_STATE});
  await startBackgroundTransport(c);
  c.data.bridgeMutationRevokingTabs=[65];
  const restartedWorker=await import('../extension/background-coordinator.js?grant-during-tab-revoke');
  restartedWorker.installBackgroundCoordinator(c);
  const result=await sendCoordinatorTo(c,c.listeners.at(-1),'grant-background-control',{
    tabId:65,durationMinutes:60,localGesture:true
  });
  assert.equal(result.error,'TAB_MUTATION_REVOKING');
  assert.equal(c.session.bridgeBackgroundControlGrants?.['65'],undefined,
    'a durable Revoke fence must prevent a replacement worker from creating a new grant');
});

test('replacement worker blocks every new Grant while a durable global Revoke fence exists',async()=>{
  const c=fakeChrome({...LAB_STATE});
  await startBackgroundTransport(c);
  c.data.bridgeMutationRevocationPending={
    pending:true,token:'pending-global-revoke-001',affectedTabs:[66],startedAt:Date.now()
  };
  c.session.bridgeMutationRevocationPending=c.data.bridgeMutationRevocationPending;
  const restartedWorker=await import('../extension/background-coordinator.js?grant-during-global-revoke');
  restartedWorker.installBackgroundCoordinator(c);
  const result=await sendCoordinatorTo(c,c.listeners.at(-1),'grant-background-control',{
    tabId:67,durationMinutes:60,localGesture:true
  });
  assert.equal(result.error,'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');
  assert.equal(c.session.bridgeBackgroundControlGrants?.['67'],undefined,
    'a global Revoke fence must prevent grants for all tabs after worker replacement');
});

test('per-tab Revoke persists its admission fence across an MV3 worker restart',async()=>{
  let writeEnteredResolve,releaseWriteResolve;
  const writeEntered=new Promise(resolve=>{writeEnteredResolve=resolve;});
  const heldWrite=new Promise(resolve=>{releaseWriteResolve=resolve;});
  const c=fakeChrome({...LAB_STATE},{beforeGrantStoreWrite:async()=>{
    writeEnteredResolve();
    await heldWrite;
  }});
  await startBackgroundTransport(c);
  c.data.bridgeConnectionDesired=true;
  c.data.bridgeMutationLabMode=true;

  const firstWorker=await import('../extension/background-coordinator.js?revoke-worker-before-restart');
  firstWorker.installBackgroundCoordinator(c);
  const revoke=sendCoordinatorTo(c,c.listeners.at(-1),'revoke-background-control',{tabId:49});
  await writeEntered;
  assert.deepEqual(c.data.bridgeMutationRevokingTabs,[49],
    'Revoke must persist its deny marker before waiting on the grant-store write');

  // A distinct module instance represents a replacement MV3 service worker:
  // all in-memory fences/maps are empty, but Chrome storage is shared.
  const restartedWorker=await import('../extension/background-coordinator.js?revoke-worker-after-restart');
  restartedWorker.installBackgroundCoordinator(c);
  const attempted=await sendCoordinatorTo(c,c.listeners.at(-1),'dispatch',{
    command:providerPrepare(49)
  },'transport-host.html');
  assert.equal(attempted.error,'TAB_MUTATION_REVOKING');
  assert.equal(attempted.dispatchState,'NOT_PERFORMED');
  assert.equal(c.calls.some(x=>x[0]==='script'&&x[2]===49),false,
    'replacement worker must reject the tab before any page script executes');

  releaseWriteResolve();
  const revoked=await revoke;
  assert.equal(revoked.ok,true);
  assert.deepEqual(c.data.bridgeMutationRevokingTabs,[],
    'the local durable pending marker is removed only after the grant-store revoke is confirmed');
  assert.deepEqual(c.session.bridgeMutationRevokingTabs,[],
    'the session fallback marker is also removed after the grant-store revoke is confirmed');
});


test('concurrent per-tab Revokes preserve every durable fence',async()=>{
  let writeEnteredResolve,releaseWriteResolve;
  const writeEntered=new Promise(resolve=>{writeEnteredResolve=resolve;});
  const heldWrite=new Promise(resolve=>{releaseWriteResolve=resolve;});
  const c=fakeChrome({...LAB_STATE},{beforeGrantStoreWrite:async()=>{
    writeEnteredResolve();
    await heldWrite;
  }});
  await startBackgroundTransport(c);
  c.data.bridgeConnectionDesired=true;
  c.data.bridgeMutationLabMode=true;
  installBackgroundCoordinator(c);

  const first=sendCoordinator(c,'revoke-background-control',{tabId:50});
  await writeEntered;
  const second=sendCoordinator(c,'revoke-background-control',{tabId:51});
  await delay(10);
  assert.deepEqual([...c.data.bridgeMutationRevokingTabs].sort((a,b)=>a-b),[50,51],
    'serialized read/modify/write must not lose another tab Revoke marker');
  assert.deepEqual([...c.session.bridgeMutationRevokingTabs].sort((a,b)=>a-b),[50,51]);

  releaseWriteResolve();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.ok,true);
  assert.equal(b.ok,true);
  assert.deepEqual(c.data.bridgeMutationRevokingTabs,[]);
  assert.deepEqual(c.session.bridgeMutationRevokingTabs,[]);
});

test('per-tab Revoke refuses to partially revoke an origin-wide Session Authorization lease',async()=>{
  const c=fakeChrome({...LAB_STATE});
  await startBackgroundTransport(c);
  c.session.bridgeSessionAuthorization=sessionLease();
  installBackgroundCoordinator(c);
  const result=await sendCoordinator(c,'revoke-background-control',{tabId:45});
  assert.equal(result.error,'SESSION_WIDE_REVOCATION_REQUIRED');
  assert.equal(c.session.bridgeSessionAuthorization.status,'active');
  assert.deepEqual(c.data.bridgeMutationRevokingTabs,[],
    'a known scope denial must remove its temporary durable admission fence');
  assert.deepEqual(c.session.bridgeMutationRevokingTabs,[]);
});


test('session_revoke persists a global mutation fence across MV3 worker restart',async()=>{
  let enteredResolve,releaseResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const held=new Promise(resolve=>{releaseResolve=resolve;});
  const c=fakeChrome({...LAB_STATE},{executeScript:async({name,details,origin,tabId,calls})=>{
    calls.push(['script',name,tabId]);
    if (name==='agent_context') return [{result:{
      verified:true,origin:'https://claude.ai',conversationId:'conversation_001'
    }}];
    if (name==='provider_prepare') {
      enteredResolve();
      await held;
      return [{result:{
        prepared:true,clickedSend:false,requestId:details.requestId,
        preparedId:details.preparedId,payloadHash:details.payloadHash,
        sideEffect:'composer-filled-no-send'
      }}];
    }
    return [{result:{ok:true}}];
  }});
  await prepareLab(c,60);
  const firstWorker=await import('../extension/background-coordinator.js?session-revoke-worker-before');
  firstWorker.installBackgroundCoordinator(c);
  const mutation=sendCoordinatorTo(c,c.listeners.at(-1),'dispatch',{
    command:providerPrepare(60)
  },'transport-host.html');
  await entered;
  const revoke=sendCoordinatorTo(c,c.listeners.at(-1),'dispatch',{
    command:{name:'session_revoke',bridgeEpoch:'bridge_epoch_0001',
      expires:Date.now()+90000,args:{}}
  },'transport-host.html');
  await delay(10);
  assert.equal(c.data.bridgeMutationRevocationPending?.pending,true);
  assert.deepEqual(c.data.bridgeMutationRevocationPending.affectedTabs,[60]);
  assert.equal(c.session.bridgeMutationRevocationPending?.pending,true);

  const restartedWorker=await import('../extension/background-coordinator.js?session-revoke-worker-after');
  restartedWorker.installBackgroundCoordinator(c);
  const late=await sendCoordinatorTo(c,c.listeners.at(-1),'dispatch',{
    command:providerPrepare(61)
  },'transport-host.html');
  assert.equal(late.error,'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');
  assert.equal(c.calls.some(x=>x[0]==='script'&&x[2]===61),false,
    'replacement worker must reject all new page mutations while global Revoke is pending');

  releaseResolve();
  const completed=await mutation;
  const revoked=await revoke;
  assert.equal(completed.result.prepared,true);
  assert.equal(revoked.result.revoked,true);
  assert.equal(c.session.bridgeSessionAuthorization,undefined);
  assert.equal(c.data.bridgeMutationRevocationPending,null);
  assert.equal(c.session.bridgeMutationRevocationPending,null);
});


test('session_revoke tracks and clears only the global fence stores that accepted the write',async()=>{
  for (const [failedStore,options] of [
    ['local',{failLocalSet:'bridgeMutationRevocationPending'}],
    ['session',{failSessionSet:'bridgeMutationRevocationPending'}]
  ]) {
    let enteredResolve,releaseResolve;
    const entered=new Promise(resolve=>{enteredResolve=resolve;});
    const held=new Promise(resolve=>{releaseResolve=resolve;});
    const c=fakeChrome({...LAB_STATE},{...options,executeScript:async({name,details,origin,tabId,calls})=>{
      calls.push(['script',name,tabId]);
      if (name==='agent_context') return [{result:{
        verified:true,origin:'https://claude.ai',conversationId:'conversation_001'
      }}];
      if (name==='provider_prepare') {
        enteredResolve();
        await held;
        return [{result:{
          prepared:true,clickedSend:false,requestId:details.requestId,
          preparedId:details.preparedId,payloadHash:details.payloadHash,
          sideEffect:'composer-filled-no-send'
        }}];
      }
      return [{result:{ok:true}}];
    }});
    await prepareLab(c,76);
    const mutation=sendCoordinator(c,'dispatch',{command:providerPrepare(76)},'transport-host.html');
    await entered;
    const revoke=sendCoordinator(c,'dispatch',{command:{
      name:'session_revoke',bridgeEpoch:'bridge_epoch_0001',
      expires:Date.now()+90000,args:{}
    }},'transport-host.html');
    await delay(10);
    const writtenStore=failedStore==='local'?'session':'local';
    const missingStore=failedStore;
    const writtenState=writtenStore==='local'?c.data:c.session;
    const missingState=missingStore==='local'?c.data:c.session;
    assert.equal(writtenState.bridgeMutationRevocationPending?.pending,true,
      'the successful '+writtenStore+' write must retain the global deny fence');
    assert.equal(missingState.bridgeMutationRevocationPending,undefined,
      'the failed '+missingStore+' write must not be reported as persisted');
    const restarted=await import('../extension/background-coordinator.js?partial-global-'+failedStore);
    restarted.installBackgroundCoordinator(c);
    const denied=await sendCoordinator(c,'dispatch',{command:providerPrepare(77)},'transport-host.html');
    assert.equal(denied.error,'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');
    releaseResolve();
    const [mutationResult,revokeResult]=await Promise.all([mutation,revoke]);
    assert.equal(mutationResult.result.prepared,true);
    assert.equal(revokeResult.result.revoked,true);
    assert.equal(c.data.bridgeMutationRevocationPending,null);
    assert.equal(c.session.bridgeMutationRevocationPending,null);
  }
});

test('clear-background-controls persists a global revoke fence across worker restart',async()=>{
  let enteredResolve,releaseResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const held=new Promise(resolve=>{releaseResolve=resolve;});
  const c=fakeChrome({...LAB_STATE},{executeScript:async({name,details,origin,tabId,calls})=>{
    calls.push(['script',name,tabId]);
    if (name==='agent_context') return [{result:{
      verified:true,origin:'https://claude.ai',conversationId:'conversation_001'
    }}];
    if (name==='provider_prepare') {
      enteredResolve();
      await held;
      return [{result:{
        prepared:true,clickedSend:false,requestId:details.requestId,
        preparedId:details.preparedId,payloadHash:details.payloadHash,
        sideEffect:'composer-filled-no-send'
      }}];
    }
    return [{result:{ok:true}}];
  }});
  await prepareLab(c,63);
  const firstWorker=await import('../extension/background-coordinator.js?clear-controls-worker-before');
  firstWorker.installBackgroundCoordinator(c);
  const mutation=sendCoordinatorTo(c,c.listeners.at(-1),'dispatch',{
    command:providerPrepare(63)
  },'transport-host.html');
  await entered;
  const clear=sendCoordinatorTo(c,c.listeners.at(-1),'clear-background-controls');
  await delay(10);
  assert.equal(c.data.bridgeMutationRevocationPending?.pending,true);
  assert.deepEqual(c.data.bridgeMutationRevocationPending.affectedTabs,[63]);

  const restartedWorker=await import('../extension/background-coordinator.js?clear-controls-worker-after');
  restartedWorker.installBackgroundCoordinator(c);
  const late=await sendCoordinatorTo(c,c.listeners.at(-1),'dispatch',{
    command:providerPrepare(64)
  },'transport-host.html');
  assert.equal(late.error,'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');

  releaseResolve();
  await mutation;
  const cleared=await clear;
  assert.equal(cleared.ok,true);
  assert.equal(c.session.bridgeSessionAuthorization,undefined);
  assert.equal(c.data.bridgeMutationRevocationPending,null);
  assert.equal(c.session.bridgeMutationRevocationPending,null);
});

test('recovered session_revoke quarantines prior worker tabs and reports UNKNOWN',async()=>{
  const c=fakeChrome({...LAB_STATE});
  await prepareLab(c,62);
  const pending={
    pending:true,token:'prior-worker-revoke-001',affectedTabs:[62],startedAt:Date.now()-100
  };
  c.data.bridgeMutationRevocationPending=pending;
  c.session.bridgeMutationRevocationPending=pending;
  const restartedWorker=await import('../extension/background-coordinator.js?session-revoke-recovery');
  restartedWorker.installBackgroundCoordinator(c);
  const authorize=await sendCoordinatorTo(c,c.listeners.at(-1),'dispatch',{
    command:{name:'session_authorize',bridgeEpoch:'bridge_epoch_0001',
      expires:Date.now()+90000,args:{sessionId:'session_0002',durationMinutes:60,
        origins:['https://claude.ai']}}
  },'transport-host.html');
  assert.equal(authorize.error,'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS',
    'a pending global Revoke must block a new Session Authorization');
  const result=await sendCoordinatorTo(c,c.listeners.at(-1),'dispatch',{
    command:{name:'session_revoke',bridgeEpoch:'bridge_epoch_0001',
      expires:Date.now()+90000,args:{}}
  },'transport-host.html');
  assert.equal(result.error,'BACKGROUND_STOP_UNCONFIRMED');
  assert.equal(result.dispatchState,'UNKNOWN');
  assert.deepEqual(result.quarantinedTabs,[62]);
  assert.ok(
    c.data.bridgeMutationQuarantinedTabs?.includes(62) ||
    c.session.bridgeMutationQuarantinedTabs?.includes(62),
    'prior-worker tabs must remain durably quarantined in local or session storage'
  );
  assert.equal(c.session.bridgeSessionAuthorization,undefined);
  assert.equal(c.data.bridgeMutationRevocationPending,null);
  assert.equal(c.session.bridgeMutationRevocationPending,null);
});

test('session_revoke fences new provider work and drains an already accepted page action',async()=>{
  let enteredResolve,releaseResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});
  const held=new Promise(resolve=>{releaseResolve=resolve;});
  const c=fakeChrome({...LAB_STATE},{executeScript:async({name,details,origin,tabId,calls})=>{
    calls.push(['script',name,tabId]);
    if (name==='agent_context') return [{result:{
      verified:true,origin:'https://claude.ai',conversationId:'conversation_001'
    }}];
    if (name==='provider_prepare') {
      enteredResolve();
      await held;
      calls.push(['page-action-completed',tabId]);
      return [{result:{
        prepared:true,clickedSend:false,requestId:details.requestId,
        preparedId:details.preparedId,payloadHash:details.payloadHash,
        sideEffect:'composer-filled-no-send'
      }}];
    }
    return [{result:{ok:true}}];
  }});
  await prepareLab(c,46);

  const mutation=sendCoordinator(c,'dispatch',{command:providerPrepare(46)},'transport-host.html');
  await entered;
  let revokeDone=false;
  const revoke=sendCoordinator(c,'dispatch',{
    command:{name:'session_revoke',bridgeEpoch:'bridge_epoch_0001',expires:Date.now()+90000,args:{}}
  },'transport-host.html').then(result=>{revokeDone=true;return result;});
  await delay(10);
  const late=await sendCoordinator(c,'dispatch',{command:providerPrepare(47)},'transport-host.html');
  assert.equal(late.error,'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');
  assert.equal(revokeDone,false);

  releaseResolve();
  const completed=await mutation;
  const revoked=await revoke;
  assert.equal(completed.result.prepared,true);
  assert.equal(revoked.result.revoked,true);
  assert.equal(c.session.bridgeSessionAuthorization,undefined);
  assert.equal(c.data.bridgeMutationLabMode,false);
});


test('per-tab Revoke write failure returns UNKNOWN and quarantines the tab',async()=>{
  const c=fakeChrome({...LAB_STATE},{failGrantStoreWrite:true});
  await startBackgroundTransport(c);
  c.session.bridgeBackgroundControlGrants={
    '48':{origin:'https://claude.ai',expires:Date.now()+60000}
  };
  installBackgroundCoordinator(c);
  const result=await sendCoordinator(c,'revoke-background-control',{tabId:48});
  assert.equal(result.error,'BACKGROUND_REVOKE_UNCONFIRMED');
  assert.equal(result.outcome,'UNKNOWN');
  assert.deepEqual(result.quarantinedTabs,[48]);
  assert.deepEqual(c.data.bridgeMutationQuarantinedTabs,[48]);
});

test('session_authorize failure to clear legacy grants sets a durable global lock',async()=>{
  const c=fakeChrome({...LAB_STATE},{failSessionRemove:'bridgeBackgroundControlGrants'});
  await startBackgroundTransport(c);
  installBackgroundCoordinator(c);
  await sendCoordinator(c,'transport-status',{
    status:{state:'connected',connected:true}
  },'transport-host.html');
  const result=await sendCoordinator(c,'dispatch',{
    command:{
      name:'session_authorize',
      bridgeEpoch:'bridge_epoch_0001',
      expires:Date.now()+90000,
      args:{
        sessionId:'session_0002',
        durationMinutes:60,
        origins:['https://claude.ai']
      }
    }
  },'transport-host.html');
  assert.equal(result.error,'BACKGROUND_CONTROL_CLEAR_FAILED');
  assert.equal(result.dispatchState,'UNKNOWN');
  assert.equal(c.data.bridgeMutationLabMode,false);
  assert.equal(c.data.bridgeMutationQuarantineLock,true);
  const restart=await startBackgroundTransport(c);
  assert.equal(restart.ok,false);
  assert.equal(restart.reason,'BACKGROUND_CONTROL_CLEAR_FAILED');
});

test('partial grant/session cleanup failure makes Stop UNKNOWN and leaves a durable global reconnect lock',async()=>{
  const c=fakeChrome({...LAB_STATE},{failSessionRemove:'bridgeSessionAuthorization'});
  await startBackgroundTransport(c);
  c.session.bridgeSessionAuthorization=sessionLease();
  installBackgroundCoordinator(c);
  const stop=await sendCoordinator(c,'stop-background');
  assert.equal(stop.ok,false);
  assert.equal(stop.reason,'BACKGROUND_CONTROL_CLEAR_FAILED');
  assert.equal(stop.outcome,'UNKNOWN',
    'some grants may already have been cleared even though Session Authorization removal failed');
  assert.equal(c.data.bridgeMutationQuarantineLock,true);
  const restarted=await startBackgroundTransport(c);
  assert.equal(restarted.ok,false);
  assert.equal(restarted.reason,'BACKGROUND_CONTROL_CLEAR_FAILED');

  const clear=await sendCoordinator(c,'clear-background-controls');
  assert.equal(clear.error,'BACKGROUND_CONTROL_CLEAR_FAILED');
  assert.equal(clear.outcome,'UNKNOWN',
    'the Control UI must not claim NOT_PERFORMED after a partial revoke');
});
