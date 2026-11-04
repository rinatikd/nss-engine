import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startBackgroundTransport, installBackgroundCoordinator} from '../extension/background-coordinator.js';

function fakeChrome(data={}) {
  const listeners=[];
  const calls=[];
  return {
    calls,listeners,
    storage:{local:{
      setAccessLevel:async opts=>calls.push(['restrict',opts.accessLevel]),
      get:async keys=>Object.fromEntries(keys.map(k=>[k,data[k]])),
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
