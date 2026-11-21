import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';

const extension = new URL('../extension/', import.meta.url);
const source = name => readFileSync(new URL(name, extension), 'utf8');

// Execute the real offscreen code with a synthetic Worker and synthetic
// chrome.runtime transport. We never contact Chrome or a production port.
function hostFixture() {
  const pending=[];
  const listeners=[];
  let workerInstance;
  class FakeWorker {
    constructor() { this.messages=[]; workerInstance=this; }
    postMessage(value) { this.messages.push(value); }
  }
  const chrome={runtime:{
    id:'mock-extension',
    sendMessage:async()=>({ok:true}),
    onMessage:{addListener:fn=>listeners.push(fn)}
  }};
  let nextTimer=0;
  const timers=new Map();
  const context={
    Worker:FakeWorker,chrome,console,
    setTimeout:(fn)=>{const id=++nextTimer;timers.set(id,fn);return id;},
    clearTimeout:id=>timers.delete(id)
  };
  runInNewContext(source('transport-host.js'),context);
  const send=(message,sender={id:'mock-extension'})=>{
    let response;
    const result=listeners[0](message,sender,value=>{response=value;});
    return {result,response:()=>response};
  };
  return {
    worker:workerInstance,send,timers,
    ack:msg=>workerInstance.onmessage({data:msg})
  };
}

test('offscreen start waits for Worker ACK instead of acknowledging queued postMessage',async()=>{
  const f=hostFixture();
  const response=f.send({target:'bridge-offscreen',type:'start',token:'dummy'});
  assert.equal(response.result,true);
  assert.equal(response.response(),undefined);
  const posted=f.worker.messages[0];
  assert.equal(posted.type,'start');
  assert.ok(Number.isSafeInteger(posted.requestId));
  await f.ack({type:'control-ack',operation:'start',
    requestId:posted.requestId,ok:true});
  assert.deepEqual(JSON.parse(JSON.stringify(response.response())),{ok:true});
});

test('offscreen does not accept mismatched ACK or ACK for wrong command',async()=>{
  const f=hostFixture();
  const response=f.send({target:'bridge-offscreen',type:'stop'});
  const posted=f.worker.messages[0];
  await f.ack({type:'control-ack',operation:'start',requestId:posted.requestId,ok:true});
  assert.equal(response.response(),undefined);
  await f.ack({type:'control-ack',operation:'stop',requestId:posted.requestId+1,ok:true});
  assert.equal(response.response(),undefined);
  await f.ack({type:'control-ack',operation:'stop',requestId:posted.requestId,
    ok:false,reason:'WORKER_STOP_FAILED'});
  assert.equal(response.response().ok,false);
  assert.equal(response.response().reason,'WORKER_STOP_FAILED');
});

test('offscreen fails closed if Worker never acknowledges the stop',async()=>{
  const f=hostFixture();
  const response=f.send({target:'bridge-offscreen',type:'stop'});
  assert.equal(response.response(),undefined);
  assert.equal(f.timers.size,1);
  for(const fn of f.timers.values()) fn();
  // sendResponse is invoked through a resolved Promise in the host handler.
  await Promise.resolve();
  assert.equal(response.response().ok,false);
  assert.equal(response.response().reason,'WORKER_CONTROL_ACK_TIMEOUT');
  await f.ack({type:'control-ack',operation:'stop',
    requestId:f.worker.messages[0].requestId,ok:true});
  assert.equal(response.response().ok,false);
});

test('offscreen rejects runtime commands from a content script',()=>{
  const f=hostFixture();
  const response=f.send({target:'bridge-offscreen',type:'stop'},
    {id:'mock-extension',tab:{id:1}});
  assert.equal(response.result,false);
  assert.equal(response.response().ok,false);
  assert.equal(f.worker.messages.length,0);
});

function workerFixture() {
  const posted=[];
  let handler;
  const transports=[];
  class FakeBridgeTransport {
    constructor({onStatus}) {
      this.onStatus=onStatus;
      this.active=false;
      transports.push(this);
    }
    async start(token) {
      if(typeof token !== 'string'||!token.trim()) throw Error('KEY_EMPTY');
      this.active=true;
      this.onStatus({state:'connecting',connected:false});
    }
    stop() {
      this.active=false;
      this.onStatus({state:'disconnected',connected:false});
    }
  }
  const self={
    postMessage:msg=>posted.push(msg),
    get onmessage(){return handler;},
    set onmessage(fn){handler=fn;}
  };
  const code=source('transport-worker.js').replace(
    /^import\s+\{ BridgeTransport \}\s+from\s+'\.\/transport-engine\.js';\s*/,'');
  assert.ok(!code.startsWith('import '),'Worker source import rewriting failed');
  runInNewContext(code,{
    self,BridgeTransport:FakeBridgeTransport,
    setTimeout:()=>1,clearTimeout:()=>{},Date,Map,Number,Error
  });
  return {posted,transports,receive:msg=>handler({data:msg})};
}

test('Worker acknowledges a processed start and stop without exposing token in ACK',async()=>{
  const f=workerFixture();
  f.receive({type:'start',requestId:101,token:'fixture'});
  await new Promise(resolve => setImmediate(resolve));
  const start=f.posted.find(x=>x.type==='control-ack'&&x.requestId===101);
  assert.equal(start?.ok,true);
  assert.equal(start?.token,undefined);
  f.receive({type:'stop',requestId:102});
  const stop=f.posted.find(x=>x.type==='control-ack'&&x.requestId===102);
  assert.equal(stop?.ok,true);
  assert.equal(f.transports[0].active,false);
});

test('Worker rejects missing token and ignores uncorrelated legacy control messages',async()=>{
  const f=workerFixture();
  f.receive({type:'start',requestId:1,token:''});
  f.receive({type:'start',token:'fixture'});
  await Promise.resolve();
  const ack=f.posted.find(x=>x.requestId===1&&x.type==='control-ack');
  assert.equal(ack?.ok,false);
  assert.equal(ack?.reason,'KEY_EMPTY');
  assert.equal(f.transports.length,0);
});

test('Worker does not acknowledge a stale start after later stop',async()=>{
  const posted=[];
  let handler;
  let releaseStart;
  const startBarrier=new Promise(resolve=>{releaseStart=resolve;});
  class DeferredBridgeTransport {
    async start() { await startBarrier; }
    stop() {}
  }
  const self={
    postMessage:msg=>posted.push(msg),
    set onmessage(fn){handler=fn;}
  };
  const code=source('transport-worker.js').replace(
    /^import\s+\{ BridgeTransport \}\s+from\s+'\.\/transport-engine\.js';\s*/,'');
  runInNewContext(code,{
    self,BridgeTransport:DeferredBridgeTransport,
    setTimeout:()=>1,clearTimeout:()=>{},Date,Map,Number,Error
  });
  handler({data:{type:'start',requestId:11,token:'fixture'}});
  handler({data:{type:'stop',requestId:12}});
  releaseStart();
  // Allow nested async start() and the Worker acknowledgement continuation.
  for(let i=0;i<8;i++) await Promise.resolve();
  const started=posted.find(x=>x.type==='control-ack'&&x.requestId===11);
  const stopped=posted.find(x=>x.type==='control-ack'&&x.requestId===12);
  assert.equal(started?.ok,false);
  assert.equal(started?.reason,'START_SUPERSEDED_BY_STOP');
  assert.equal(stopped?.ok,true);
});
test('offscreen reports failed worker.postMessage rather than false success',async()=>{
  const f=hostFixture();
  f.worker.postMessage=()=>{throw Error('WORKER_TERMINATED');};
  const response=f.send({target:'bridge-offscreen',type:'stop'});
  await Promise.resolve();
  assert.equal(response.response().ok,false);
  assert.equal(response.response().reason,'WORKER_CONTROL_POST_FAILED');
});

test('Worker rejects credential rotation while a transport is already active',async()=>{
  const posted=[];
  let handler;
  let actualStartCount=0;
  class CredentialTransport {
    constructor({onStatus}) {this.onStatus=onStatus;this.active=false;this.token=null;}
    async start(token) {
      actualStartCount++;
      this.active=true;
      this.token=token;
    }
    stop(){this.active=false;this.token=null;}
  }
  const self={postMessage:m=>posted.push(m),set onmessage(fn){handler=fn;}};
  const code=source('transport-worker.js').replace(
    /^import\s+\{ BridgeTransport \}\s+from\s+'\.\/transport-engine\.js';\s*/,'');
  runInNewContext(code,{self,BridgeTransport:CredentialTransport,
    setTimeout:()=>1,clearTimeout:()=>{},Date,Map,Number,Error});
  handler({data:{type:'start',requestId:21,token:'credential-A'}});
  for(let i=0;i<6;i++) await Promise.resolve();
  handler({data:{type:'start',requestId:22,token:'credential-B'}});
  for(let i=0;i<6;i++) await Promise.resolve();
  const ackA=posted.find(x=>x.type==='control-ack'&&x.requestId===21);
  const ackB=posted.find(x=>x.type==='control-ack'&&x.requestId===22);
  assert.equal(ackA?.ok,true);
  assert.equal(ackB?.ok,false);
  assert.equal(ackB?.reason,'ACTIVE_SESSION_CREDENTIAL_MISMATCH');
  assert.equal(actualStartCount,1);
  assert.equal(JSON.stringify(ackB).includes('credential-'),false);
});

test('obsolete rejected Worker start cannot override status after stop',async()=>{
  const posted=[];
  let handler;
  let rejectStart;
  const barrier=new Promise((_resolve,reject)=>{rejectStart=reject;});
  class FailingTransport {
    async start(){await barrier;}
    stop(){}
  }
  const self={postMessage:m=>posted.push(m),set onmessage(fn){handler=fn;}};
  const code=source('transport-worker.js').replace(
    /^import\s+\{ BridgeTransport \}\s+from\s+'\.\/transport-engine\.js';\s*/,'');
  runInNewContext(code,{self,BridgeTransport:FailingTransport,
    setTimeout:()=>1,clearTimeout:()=>{},Date,Map,Number,Error});
  handler({data:{type:'start',requestId:31,token:'fixture'}});
  handler({data:{type:'stop',requestId:32}});
  rejectStart(Error('NETWORK_DOWN'));
  for(let i=0;i<8;i++) await Promise.resolve();
  const ack=posted.find(x=>x.type==='control-ack'&&x.requestId===31);
  assert.equal(ack?.ok,false);
  assert.equal(ack?.reason,'START_SUPERSEDED_BY_STOP');
  assert.equal(posted.some(x=>x.type==='transport-status'&&x.status?.state==='error'),false);
});
