import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BridgeTransport} from '../extension/transport-engine.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = body => ({ok:true,status:200,json:async()=>body});

test('a transient network outage recovers, and manual stop prevents further polls', async () => {
  let calls=0;
  let releaseBackoff;
  const statuses=[];
  const oldWarn=console.warn;
  console.warn=()=>{};
  let transport;
  try {
    transport=new BridgeTransport({
      endpoint:'http://127.0.0.1:17481',
      fetchImpl: async (_url,options) => {
        calls++;
        if (calls===1) throw new TypeError('simulated network outage');
        if (calls===2) return ok({epoch:'test-epoch',command:null});
        return new Promise((_resolve,reject) =>
          options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
      },
      execute:async()=>({}),
      onStatus:s=>statuses.push(s.state),
      sleepImpl:()=>new Promise(resolve=>{releaseBackoff=resolve;})
    });
    await transport.start('synthetic-key');
    for(let i=0;i<40 && !releaseBackoff;i++) await tick();
    assert.equal(transport.lastStatus.state,'recovering');
    assert.equal(transport.lastStatus.error,'BRIDGE_NETWORK_UNREACHABLE');
    releaseBackoff();
    for(let i=0;i<40 && calls<3;i++) await tick();
    assert.equal(calls,3);
    assert.equal(transport.lastStatus.state,'connected');
    assert.deepEqual(statuses.slice(0,3),['connecting','recovering','connected']);
    transport.stop();
    for(let i=0;i<5;i++) await tick();
    assert.equal(transport.lastStatus.state,'disconnected');
    assert.equal(transport.token,null);
    assert.equal(calls,3);
  } finally {
    transport?.stop();
    console.warn=oldWarn;
  }
});

test('invalid origin response fails closed without retrying the browser key', async () => {
  let calls=0;
  const transport=new BridgeTransport({
    fetchImpl:async()=>{calls++;return {ok:false,status:403};},
    execute:async()=>({})
  });
  await transport.start('synthetic-key');
  for(let i=0;i<30 && transport.lastStatus.state!=='auth-failed';i++) await tick();
  assert.equal(transport.lastStatus.state,'auth-failed');
  assert.equal(transport.lastStatus.error,'EXTENSION_ORIGIN_REJECTED_403');
  assert.equal(transport.token,null);
  assert.equal(transport.active,false);
  assert.equal(calls,1);
});

test('stop aborts in-flight poll and does not change disconnected state on late error',async()=>{
  let rejectPoll;
  let started=false;
  const t=new BridgeTransport({
    fetchImpl:async()=>{started=true;return new Promise((_resolve,reject)=>{rejectPoll=reject;});},
    execute:async()=>({})
  });
  await t.start('synthetic-key');
  for(let i=0;i<20 && !started;i++) await tick();
  assert.equal(started,true);
  t.stop();
  rejectPoll(new TypeError('late connection error'));
  for(let i=0;i<4;i++) await tick();
  assert.equal(t.lastStatus.state,'disconnected');
  assert.equal(t.active,false);
  assert.equal(t.token,null);
});
