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
  await Promise.resolve();
  await Promise.resolve();
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
