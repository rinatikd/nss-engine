import { BridgeTransport } from './transport-engine.js';

// Worker executes NO browser actions. Only the service worker can dispatch
// permission-gated commands; this worker owns the HTTP poll connection.
const pending = new Map();
let seq = 0;
let transport = null;
const send = (data) => self.postMessage(data);
function delegate(command) {
  // All operations go through the coordinator's session and action gates.
  const id = ++seq;
  return new Promise((resolve,reject) => {
    const expires=Number.isFinite(command.expires)?command.expires:Date.now()+12000;
    const remaining=Math.max(1,Math.min(120000,expires-Date.now()+1000));
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('DISPATCH_TIMEOUT'));
    }, remaining);
    pending.set(id,{resolve,reject,timer});
    send({type:'dispatch',id,command});
  });
}
const start = async (token) => {
  if (!transport) {
    transport = new BridgeTransport({
      execute: delegate,
      onStatus: (status) => send({type:'transport-status',status})
    });
  }
  // A running transport cannot silently adopt a different browser token:
  // BridgeTransport.start() otherwise returns false and the caller would
  // receive a misleading success while polling with the old credential.
  if (transport.active === true && transport.token !== token.trim())
    throw Error('ACTIVE_SESSION_CREDENTIAL_MISMATCH');
  await transport.start(token);
};
// Control ACKs are emitted by the Worker only after the requested operation
// has been processed. Host-side postMessage merely queues a command.
let controlGeneration = 0;
const acknowledge = (requestId, type, ok, reason = null) => {
  send({type:'control-ack',requestId,operation:type,ok,reason});
};
self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start' && Number.isSafeInteger(msg.requestId)) {
    const myGeneration = ++controlGeneration;
    if (typeof msg.token !== 'string' || !msg.token.trim()) {
      acknowledge(msg.requestId,'start',false,'KEY_EMPTY');
      return;
    }
    void start(msg.token).then(() => {
      // A later stop invalidates the earlier start acknowledgement.
      if (myGeneration !== controlGeneration)
        acknowledge(msg.requestId,'start',false,'START_SUPERSEDED_BY_STOP');
      else acknowledge(msg.requestId,'start',true);
    }, e => {
      const superseded = myGeneration !== controlGeneration;
      acknowledge(msg.requestId,'start',false,
        superseded ? 'START_SUPERSEDED_BY_STOP' :
        e?.message === 'ACTIVE_SESSION_CREDENTIAL_MISMATCH'
          ? 'ACTIVE_SESSION_CREDENTIAL_MISMATCH' : 'WORKER_START_FAILED');
      // Do not overwrite a later successful stop/reconnect status with
      // a delayed failure from an obsolete start request.
      if (!superseded) send({type:'transport-status',status:{
        state:'error',connected:false,error:'WORKER_START_FAILED'
      }});
    });
  } else if (msg.type === 'stop' && Number.isSafeInteger(msg.requestId)) {
    ++controlGeneration;
    try {
      transport?.stop();
      for (const [id,p] of pending) {
        clearTimeout(p.timer);
        p.reject(Error('Stopped'));
        pending.delete(id);
      }
      acknowledge(msg.requestId,'stop',true);
    } catch {
      acknowledge(msg.requestId,'stop',false,'WORKER_STOP_FAILED');
    }
  } else if (msg.type === 'dispatch-result') {
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.error) p.reject(Error(msg.error)); else p.resolve(msg.result);
  }
};
