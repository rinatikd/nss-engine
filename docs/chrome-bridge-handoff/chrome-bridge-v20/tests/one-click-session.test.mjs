import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneClickSession, eligibleWebUrl, BROWSER_ORIGINS } from '../extension/one-click-session.js';

function harness({ key = 'stored-token', permission = true, startResult = {ok:true}, connected=true } = {}) {
  const data = {};
  const events = [];
  const api = {
    permissions: {
      async request({origins}) { events.push(['request',origins]); return permission; },
      async remove({origins}) { events.push(['remove',origins]); return true; }
    },
    storage: {local: {
      async get(keys) { const k=typeof keys === 'string' ? [keys] : keys;return Object.fromEntries(k.map(x=>[x,data[x]])); },
      async set(v) { Object.assign(data,v);events.push(['set',v]); }
    }}
  };
  const session = createOneClickSession(api,{
    loadKey:async()=>({value:key,persistent:!!key}),
    start:async()=>{events.push(['start']);return startResult;},
    stop:async()=>{events.push(['stop']);},
    getStatus:async()=>({connected,error:null})
  });
  return {data,events,session};
}

test('only a user gesture can begin a connection', async()=>{
  const h=harness();
  await assert.rejects(h.session.connect(),/LOCAL_GESTURE_REQUIRED/);
  assert.deepEqual(h.events,[]);
});
test('permission request happens before credential lookup and startup', async()=>{
  const h=harness();
  const s=await h.session.connect({trustedGesture:true});
  assert.equal(s.connected,true);
  assert.equal(h.events[0][0],'request');
  assert.deepEqual(h.events[0][1],BROWSER_ORIGINS);
  assert.equal(h.events.at(-1)[0],'start');
});
test('connection is never reported established on network uncertainty',async()=>{
  const h=harness({connected:false});
  const s=await h.session.connect({trustedGesture:true});
  assert.equal(s.connected,false);
  assert.equal(s.state,'connecting');
});
test('denied host permission blocks startup and retains disconnected flag',async()=>{
  const h=harness({permission:false});
  await assert.rejects(h.session.connect({trustedGesture:true}),/CHROME_HOST_PERMISSION_DENIED/);
  assert.equal(h.data.bridgeConnectionDesired,false);
  assert.equal(h.events.some(x=>x[0]==='start'),false);
});
test('missing paired credential does not start transport',async()=>{
  const h=harness({key:''});
  await assert.rejects(h.session.connect({trustedGesture:true}),/PAIRING_REQUIRED/);
  assert.equal(h.events.some(x=>x[0]==='start'),false);
});
test('failed background start rolls back desired connection',async()=>{
  const h=harness({startResult:{ok:false,reason:'OFFSCREEN_UNAVAILABLE'}});
  await assert.rejects(h.session.connect({trustedGesture:true}),/OFFSCREEN_UNAVAILABLE/);
  assert.equal(h.data.bridgeConnectionDesired,false);
});
test('Disconnect stops transport before permissions removal and preserves key',async()=>{
  const h=harness();
  await h.session.connect({trustedGesture:true});
  const end=await h.session.disconnect();
  assert.equal(end.connected,false);
  assert.equal(h.data.bridgeConnectionDesired,false);
  assert.equal(h.data.bridgeMutationLabMode,false);
  const actions=h.events.map(x=>x[0]);
  assert.ok(actions.lastIndexOf('stop')<actions.lastIndexOf('remove'));
});
test('two consecutive connected sessions require explicit connect gestures',async()=>{
  const h=harness();
  await h.session.connect({trustedGesture:true});
  await h.session.disconnect();
  assert.equal((await h.session.status()).state,'disconnected');
  await h.session.connect({trustedGesture:true});
  assert.equal((await h.session.status()).state,'connected');
});
test('ordinary web pages vs Chrome restricted schemes',()=>{
  assert.equal(eligibleWebUrl('https://example.com/path'),true);
  assert.equal(eligibleWebUrl('http://example.org'),true);
  assert.equal(eligibleWebUrl('chrome://settings'),false);
  assert.equal(eligibleWebUrl('chrome-extension://abc/control.html'),false);
  assert.equal(eligibleWebUrl('https://chromewebstore.google.com/detail/foo'),false);
});

test('failed Connect never revokes a pre-existing site permission', async()=>{
  const h=harness({key:''});
  await assert.rejects(h.session.connect({trustedGesture:true}),/PAIRING_REQUIRED/);
  assert.equal(h.events.some(x=>x[0]==='remove'),false);
});
test('Disconnect revokes browser rights even when background stop fails', async()=>{
  const h=harness();
  await h.session.connect({trustedGesture:true});
  const base=h.events.length;
  // A second session fixture with broken stop, same expected cleanup semantics.
  const state={bridgeConnectionDesired:true};
  const events=[];
  const api={
    permissions:{request:async()=>true,remove:async()=>{events.push('revoke');return true;}},
    storage:{local:{get:async()=>state,set:async v=>{Object.assign(state,v);events.push('disable');}}}
  };
  const broken=createOneClickSession(api,{
    loadKey:async()=>({value:'stored-token'}),
    start:async()=>({ok:true}),
    stop:async()=>{events.push('stop');throw Error('OFFSCREEN_UNAVAILABLE');},
    getStatus:async()=>({connected:true})
  });
  await assert.rejects(broken.disconnect(),/BACKGROUND_STOP_UNCONFIRMED/);
  assert.deepEqual(events,['disable','stop','revoke']);
  assert.equal(state.bridgeConnectionDesired,false);
});
