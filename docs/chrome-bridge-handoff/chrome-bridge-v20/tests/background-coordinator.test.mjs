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
