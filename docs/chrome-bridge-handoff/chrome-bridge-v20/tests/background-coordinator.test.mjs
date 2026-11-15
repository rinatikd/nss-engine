import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startBackgroundTransport, stopBackgroundTransport, installBackgroundCoordinator} from '../extension/background-coordinator.js';

function fakeChrome(data={}) {
  const listeners=[];
  const calls=[];
  return {
    calls,listeners,
    storage:{local:{
      setAccessLevel:async opts=>calls.push(['restrict',opts.accessLevel]),
      get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),
      set:async next=>{Object.assign(data,next);calls.push(['set',next]);}
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
test('content scripts cannot spoof coordinator status or dispatch',async()=>{
  const c=fakeChrome({
    bridgeBackgroundMode:true,bridgeConnectionDesired:true,
    bridgeAllTabsMode:true,bridgeMutationLabMode:true
  });
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
  assert.equal(invoke(msg,{id:c.runtime.id,url:c.runtime.getURL('transport-host.html')}),true);
  await Promise.resolve();
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

test('disconnect disables dispatch before grant cleanup and offscreen stop',async()=>{
  const state={bridgeConnectionDesired:true,bridgeMutationLabMode:true,bridgeAllTabsMode:true};
  const chrome=fakeChrome(state);
  chrome.storage.session={
    setAccessLevel:async()=>chrome.calls.push(['session-access']),
    remove:async()=>chrome.calls.push(['clear-grants'])
  };
  await stopBackgroundTransport(chrome);
  assert.equal(state.bridgeConnectionDesired,false);
  assert.equal(state.bridgeMutationLabMode,false);
  assert.equal(state.bridgeAllTabsMode,false);
  const calls=chrome.calls.map(x=>x[0]==='message'?x[1]:x[0]);
  assert.ok(calls.indexOf('set')<calls.indexOf('clear-grants'));
  assert.ok(calls.indexOf('clear-grants')<calls.indexOf('stop'));
});

test('failed grant cleanup still disables dispatch and attempts offscreen stop',async()=>{
  const state={bridgeConnectionDesired:true,bridgeMutationLabMode:true,bridgeAllTabsMode:true};
  const chrome=fakeChrome(state);
  chrome.storage.session={
    setAccessLevel:async()=>{throw Error('SESSION_STORAGE_FAILED');},
    remove:async()=>{throw Error('unexpected-clear');}
  };
  await assert.rejects(stopBackgroundTransport(chrome),/BACKGROUND_GRANT_CLEANUP_FAILED/);
  assert.equal(state.bridgeConnectionDesired,false);
  assert.equal(state.bridgeAllTabsMode,false);
  assert.equal(state.bridgeMutationLabMode,false);
  assert.ok(chrome.calls.some(x=>x[0]==='message' && x[1]==='stop'));
});

test('disconnect during offscreen creation cannot start stale background transport',async()=>{
  const flags={bridgeBackgroundMode:true,bridgeConnectionDesired:true,browserToken:'fixture-only'};
  const chrome=fakeChrome(flags);
  let releaseHost;
  let hostCreationStarted;
  const started=new Promise(resolve=>{hostCreationStarted=resolve;});
  const barrier=new Promise(resolve=>{releaseHost=resolve;});
  chrome.offscreen.createDocument=async()=>{
    chrome.calls.push(['create','WORKERS']);
    hostCreationStarted();
    await barrier;
  };
  const attempt=startBackgroundTransport(chrome);
  await started;
  // Simulate the persisted user-disconnect intent while Chrome is creating
  // an offscreen host, without injecting secrets or exercising a real browser.
  flags.bridgeConnectionDesired=false;
  releaseHost();
  const result=await attempt;
  assert.equal(result.ok,false);
  assert.equal(result.reason,'MANUAL_DISCONNECT_DURING_START');
  assert.equal(chrome.calls.some(x=>x[0]==='message' && x[1]==='start'),false);
});

test('start rejects an offscreen host that explicitly fails to accept the command',async()=>{
  const c=fakeChrome({bridgeBackgroundMode:true,bridgeConnectionDesired:true,browserToken:'fixture-only'});
  c.runtime.sendMessage=async msg=>{
    c.calls.push(['message',msg.type]);
    return {ok:false};
  };
  const result=await startBackgroundTransport(c);
  assert.deepEqual(result,{ok:false,reason:'BACKGROUND_START_UNCONFIRMED'});
});

test('disconnect does not claim offscreen stop when a live host cannot be reached',async()=>{
  const state={bridgeConnectionDesired:true,bridgeMutationLabMode:true,bridgeAllTabsMode:true};
  const c=fakeChrome(state);
  c.runtime.getContexts=async()=>[{contextType:'OFFSCREEN_DOCUMENT'}];
  c.runtime.sendMessage=async msg=>{
    c.calls.push(['message',msg.type]);
    throw Error('PORT_CLOSED');
  };
  await assert.rejects(stopBackgroundTransport(c),/BACKGROUND_STOP_UNCONFIRMED/);
  assert.equal(state.bridgeConnectionDesired,false);
  assert.equal(state.bridgeMutationLabMode,false);
  assert.equal(state.bridgeAllTabsMode,false);
  assert.ok(c.calls.some(x=>x[0]==='message'&&x[1]==='stop'));
});

test('missing offscreen host is accepted as stopped after failed delivery',async()=>{
  const c=fakeChrome({bridgeConnectionDesired:true});
  c.runtime.sendMessage=async()=>{throw Error('NO_RECEIVER');};
  c.runtime.getContexts=async()=>[];
  await stopBackgroundTransport(c);
});

test('disconnect rejects an explicit negative offscreen stop acknowledgement',async()=>{
  const state={bridgeConnectionDesired:true,bridgeMutationLabMode:true};
  const c=fakeChrome(state);
  c.runtime.sendMessage=async()=>({ok:false});
  await assert.rejects(stopBackgroundTransport(c),/BACKGROUND_STOP_UNCONFIRMED/);
  assert.equal(state.bridgeConnectionDesired,false);
  assert.equal(state.bridgeMutationLabMode,false);
});

test('a delayed offscreen connected notification cannot resurrect a disconnected session',async()=>{
  const data={
    bridgeBackgroundMode:true,bridgeConnectionDesired:true,
    bridgeAllTabsMode:true,bridgeMutationLabMode:true
  };
  const c=fakeChrome(data);
  installBackgroundCoordinator(c);
  const sender={id:c.runtime.id,url:c.runtime.getURL('transport-host.html')};
  const panel={id:c.runtime.id,url:c.runtime.getURL('control.html')};
  let reply;
  const status={target:'bridge-coordinator',type:'transport-status',
    status:{state:'connected',connected:true}};
  const invoke=(msg,sender)=>c.listeners[0](msg,sender,x=>reply=x);
  assert.equal(invoke(status,sender),true);
  await Promise.resolve();
  assert.deepEqual(reply,{ok:true});
  await c.storage.local.set({
    bridgeConnectionDesired:false,bridgeAllTabsMode:false,
    bridgeMutationLabMode:false
  });
  reply=undefined;
  // The old Worker can still send queued status messages after Disconnect.
  assert.equal(invoke(status,sender),true);
  await Promise.resolve();
  assert.deepEqual(reply,{ok:false,reason:'SESSION_NOT_ACTIVE'});
  invoke({target:'bridge-coordinator',type:'status'},panel);
  assert.equal(reply.connected,false);
});

test('positive status fails closed if persistent session storage cannot be read',async()=>{
  const c=fakeChrome();
  installBackgroundCoordinator(c);
  c.storage.local.get=async()=>{throw Error('STORAGE_UNAVAILABLE');};
  const sender={id:c.runtime.id,url:c.runtime.getURL('transport-host.html')};
  let reply;
  const handled=c.listeners[0]({
    target:'bridge-coordinator',type:'transport-status',
    status:{state:'connected',connected:true}
  },sender,x=>reply=x);
  assert.equal(handled,true);
  for(let i=0;i<3;i++) await Promise.resolve();
  assert.deepEqual(reply,{ok:false,reason:'SESSION_STATE_UNAVAILABLE'});
  let visible;
  c.listeners[0]({target:'bridge-coordinator',type:'status'},
    {id:c.runtime.id,url:c.runtime.getURL('control.html')},
    result=>visible=result);
  assert.equal(visible.connected,false);
  assert.equal(visible.error,'SESSION_STATE_UNAVAILABLE');
});

test('Disconnect fences a pending positive status read even if storage returns stale true flags',async()=>{
  const flags={
    bridgeBackgroundMode:true,bridgeConnectionDesired:true,
    bridgeAllTabsMode:true,bridgeMutationLabMode:true
  };
  const c=fakeChrome(flags);
  installBackgroundCoordinator(c);
  const originalGet=c.storage.local.get;
  let releaseRead,readStarted;
  const started=new Promise(resolve=>{readStarted=resolve;});
  const barrier=new Promise(resolve=>{releaseRead=resolve;});
  c.storage.local.get=async keys=>{
    if(Array.isArray(keys)&&keys.includes('bridgeMutationLabMode')) {
      readStarted();
      await barrier;
      // Reproduce a previously captured, obsolete snapshot.
      return {
        bridgeBackgroundMode:true,bridgeConnectionDesired:true,
        bridgeAllTabsMode:true,bridgeMutationLabMode:true
      };
    }
    return originalGet(keys);
  };
  let reply;
  const handled=c.listeners[0]({
    target:'bridge-coordinator',type:'transport-status',
    status:{state:'connected',connected:true}
  },{id:c.runtime.id,url:c.runtime.getURL('transport-host.html')},
  result=>reply=result);
  assert.equal(handled,true);
  await started;
  await stopBackgroundTransport(c);
  releaseRead();
  for(let i=0;i<5;i++) await Promise.resolve();
  assert.deepEqual(reply,{ok:false,reason:'SESSION_NOT_ACTIVE'});
  let visible;
  c.listeners[0]({target:'bridge-coordinator',type:'status'},
    {id:c.runtime.id,url:c.runtime.getURL('control.html')},
    result=>visible=result);
  assert.equal(visible.connected,false);
});
