import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeTransport } from '../extension/transport-engine.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const jsonResponse = (body, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('allows only one poll loop and clears credentials on explicit stop', async () => {
  let calls = 0;
  const t = new BridgeTransport({
    fetchImpl: async (_, options) => {
      calls++;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Error('aborted')), { once:true });
      });
    },
    execute: async () => ({ ok:true })
  });
  assert.equal(await t.start('secret'), true);
  assert.equal(await t.start('secret'), false);
  await tick();
  assert.equal(calls, 1);
  t.stop();
  assert.equal(t.token, null);
  assert.equal(t.lastStatus.state, 'disconnected');
});

test('auth rejection does not loop or save a credential', async () => {
  let calls = 0;
  const statuses = [];
  const t = new BridgeTransport({
    fetchImpl: async () => { calls++; return jsonResponse({}, 401); },
    execute: async () => ({}),
    onStatus: s => statuses.push(s.state)
  });
  await t.start('secret');
  await tick();
  assert.equal(calls, 1);
  assert.equal(t.active, false);
  assert.equal(t.lastStatus.state, 'auth-failed');
  assert.equal(t.token, null);
  assert.deepEqual(statuses, ['connecting', 'auth-failed']);
});

test('command executes once when result acknowledgement is uncertain', async () => {
  let executeCalls = 0;
  let pollCalls = 0;
  let resultCalls = 0;
  const t = new BridgeTransport({
    fetchImpl: async (url, options) => {
      if (url.endsWith('/bridge/result')) {
        resultCalls++;
        if (resultCalls === 1) throw Error('connection reset after execution');
        return jsonResponse({ ok:true });
      }
      pollCalls++;
      if (pollCalls === 1) {
        return jsonResponse({ epoch:'e1', command: {
          id:'cmd1', name:'agent_send', args:{}, expires:Date.now()+120000
        }});
      }
      return new Promise((resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once:true }));
    },
    execute: async () => { executeCalls++; return { ok:true }; }
  });
  await t.start('secret');
  for (let i=0;i<20 && pollCalls<2;i++) await tick();
  assert.equal(executeCalls, 1);
  assert.equal(resultCalls, 1);
  assert.equal(pollCalls, 2);
  t.stop();
});
test('expired command is rejected without execution', async () => {
  let executed = false;
  let result = null;
  const t = new BridgeTransport({
    fetchImpl: async (url, options) => {
      if (url.endsWith('/bridge/result')) {
        result = JSON.parse(options.body);
        return jsonResponse({ ok:true });
      }
      if (!result) return jsonResponse({ epoch:'e1', command: { id:'old', name:'browser_read', args:{}, expires:Date.now()-1 }});
      t.stop();
      return jsonResponse({ epoch:'e1' });
    },
    execute: async () => { executed=true; }
  });
  await t.start('secret');
  for(let i=0;i<20 && !result;i++) await tick();
  assert.equal(executed, false);
  assert.equal(result.error, 'Command expired');
  t.stop();
});

test('network failure keeps stable public code and emits token-free diagnostic metadata', async () => {
  const priorWarn = console.warn;
  const entries = [];
  console.warn = (...a) => entries.push(a);
  try {
    const transport = new BridgeTransport({
      endpoint:'http://127.0.0.1:17481',
      fetchImpl: async () => { throw new TypeError('test secret must never be logged'); },
      execute: async () => ({}),
      sleepImpl: async () => new Promise(() => {})
    });
    await transport.start('token-must-never-be-logged');
    for(let i=0;i<20 && transport.lastStatus.state!=='recovering';i++) await tick();
    assert.equal(transport.lastStatus.error,'BRIDGE_NETWORK_UNREACHABLE');
    assert.equal(entries.length,1);
    const [label, detail] = entries[0];
    assert.equal(label,'[Chrome Bridge transport network]');
    assert.equal(detail.endpoint,'http://127.0.0.1:17481');
    assert.equal(detail.operation,'/bridge/poll');
    assert.equal(detail.errorName,'TypeError');
    assert.equal(JSON.stringify(entries).includes('token-must-never-be-logged'),false);
    assert.equal(JSON.stringify(entries).includes('test secret must never be logged'),false);
    transport.stop();
  } finally {
    console.warn = priorWarn;
  }
});

test('fetch implementation is invoked without the transport object as receiver', async () => {
  const receivers=[];
  let calls=0;
  const t=new BridgeTransport({
    fetchImpl: function(url,opts) {
      receivers.push(this);
      calls++;
      if (calls===1) return Promise.resolve(jsonResponse({epoch:'e1',command:null}));
      return new Promise((resolve,reject) => opts.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));
    },
    execute: async()=>({})
  });
  await t.start('test-token');
  for(let i=0;i<30 && calls<2;i++) await tick();
  assert.equal(calls,2);
  assert.equal(receivers[0],undefined);
  assert.equal(receivers[1],undefined);
  t.stop();
});


test('transient 503 recovers without spawning a second poll owner', async () => {
  let polls=0;
  const statuses=[];
  const backoff=[];
  const t=new BridgeTransport({
    fetchImpl:async(url,opts)=>{
      if(url.endsWith('/bridge/result')) throw Error('unexpected result');
      polls++;
      if(polls===1) return jsonResponse({},503);
      if(polls===2) return jsonResponse({epoch:'e1',command:null});
      return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));
    },
    execute:async()=>{throw Error('unexpected execution');},
    onStatus:s=>statuses.push(s.state),
    sleepImpl:async ms=>backoff.push(ms)
  });
  await t.start('synthetic-token');
  for(let i=0;i<60 && polls<3;i++) await tick();
  assert.equal(polls,3,'one recovery retry and one resumed poll');
  assert.deepEqual(backoff,[1500]);
  assert.ok(statuses.includes('recovering'));
  assert.equal(t.lastStatus.state,'connected');
  assert.equal(t.active,true);
  assert.equal(await t.start('synthetic-token'),false,'no second poll owner');
  t.stop();
  assert.equal(t.token,null);
});

test('extension origin rejection 403 fails closed without retry', async () => {
  let polls=0;
  let sleeps=0;
  const t=new BridgeTransport({
    fetchImpl:async()=>{polls++;return jsonResponse({error:'Extension Origin denied'},403);},
    execute:async()=>{},
    sleepImpl:async()=>{sleeps++;}
  });
  await t.start('synthetic-token');
  for(let i=0;i<30 && t.active;i++) await tick();
  assert.equal(t.active,false);
  assert.equal(t.token,null);
  assert.equal(t.lastStatus.state,'auth-failed');
  assert.equal(t.lastStatus.error,'EXTENSION_ORIGIN_REJECTED_403');
  assert.equal(polls,1);
  assert.equal(sleeps,0);
});

test('manual stop aborts pending poll and does not reconnect spontaneously', async () => {
  let polls=0;
  let aborts=0;
  const t=new BridgeTransport({
    fetchImpl:async(_url,opts)=>{
      polls++;
      return new Promise((_resolve,reject)=>{
        opts.signal.addEventListener('abort',()=>{aborts++;reject(Error('aborted'));},{once:true});
      });
    },
    execute:async()=>{throw Error('unexpected execution');}
  });
  await t.start('synthetic-token');
  for(let i=0;i<25 && polls<1;i++) await tick();
  assert.equal(polls,1);
  t.stop();
  for(let i=0;i<8;i++) await tick();
  assert.equal(aborts,1);
  assert.equal(polls,1);
  assert.equal(t.active,false);
  assert.equal(t.token,null);
});

test('stop while dispatch is awaiting approval suppresses result and next poll', async () => {
  let polls=0,results=0,executions=0;
  let dispatchReached;
  let releaseExecution;
  const entered=new Promise(resolve=>dispatchReached=resolve);
  const release=new Promise(resolve=>releaseExecution=resolve);
  const t=new BridgeTransport({
    fetchImpl:async(url,opts)=>{
      if(url.endsWith('/bridge/result')) {results++;return jsonResponse({ok:true});}
      polls++;
      if(polls===1) return jsonResponse({epoch:'e1',command:{
        id:'command-under-approval',name:'agent_send',args:{},expires:Date.now()+100000
      }});
      return new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));
    },
    execute:async()=>{executions++;dispatchReached();await release;return {sent:true};}
  });
  try {
    await t.start('synthetic-token');
    await entered;
    t.stop();
    releaseExecution();
    for(let i=0;i<12;i++) await tick();
    assert.equal(executions,1);
    assert.equal(results,0,'stopped transport must not ACK stale execution');
    assert.equal(polls,1,'stopped transport must not poll again');
    assert.equal(t.active,false);
    assert.equal(t.token,null);
  } finally {
    t.stop();
    releaseExecution?.();
  }
});

test('all classified and unknown 403 responses fail closed without retry', async () => {
  for (const [payload, expected] of [
    [{error:'Invalid Host'}, 'BRIDGE_HOST_REJECTED_403'],
    [{error:'Extension ID is not pinned'}, 'EXTENSION_ID_NOT_PINNED_403'],
    [{error:'unrecognized'}, 'BRIDGE_FORBIDDEN_403']
  ]) {
    let polls=0, sleeps=0;
    const transport=new BridgeTransport({
      fetchImpl:async()=>{polls++;return jsonResponse(payload,403);},
      execute:async()=>{},
      sleepImpl:async()=>{sleeps++;}
    });
    await transport.start('synthetic-token');
    for(let i=0;i<30 && transport.active;i++) await tick();
    assert.equal(transport.active,false);
    assert.equal(transport.lastStatus.state,'auth-failed');
    assert.equal(transport.lastStatus.error,expected);
    assert.equal(polls,1);
    assert.equal(sleeps,0);
  }
});
