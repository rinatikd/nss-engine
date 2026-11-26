import { BridgeTransport } from './transport-engine.js';
import { makeFailure, normalizeFailure } from './failure-contract.js';

// Worker executes NO browser actions. Only the service worker can dispatch
// permission-gated commands; this worker owns the HTTP poll connection.
const pending = new Map();
let seq = 0;
let transport = null;
// Only read-only commands and explicitly gated approved mutations are migrated.
// browser_open and agent_new_chat remain unsupported in background mode.
const unsupported = new Set(['browser_open','agent_new_chat']);
const send = (data) => self.postMessage(data);
function delegate(command) {
  // Unsupported mutating commands always fail closed; click/fill/send are
  // delegated to the coordinator, which checks lab opt-in and human approval.
  if (unsupported.has(command.name)) throw Error('COMMAND_NOT_MIGRATED');
  const id = ++seq;
  return new Promise((resolve,reject) => {
    const expires=Number.isFinite(command.expires)?command.expires:Date.now()+12000;
    const remaining=Math.max(1,Math.min(120000,expires-Date.now()+1000));
    const timer = setTimeout(() => {
      pending.delete(id);
      const error=Error('DISPATCH_TIMEOUT');
      error.failure=makeFailure('TRANSPORT','DISPATCH_TIMEOUT');
      reject(error);
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
  await transport.start(token);
};
self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start') {
    void start(msg.token).catch(e => send({type:'transport-status',status:{state:'error',connected:false,error:e.message}}));
  } else if (msg.type === 'stop') {
    transport?.stop();
    for (const [id,p] of pending) { clearTimeout(p.timer); p.reject(Error('Stopped')); pending.delete(id); }
    send({type:'stopped',stopId:msg.stopId});
  } else if (msg.type === 'dispatch-result') {
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.error) {
      const error=Error(msg.error);
      error.dispatchState=['BLOCKED','NOT_PERFORMED'].includes(msg.dispatchState)
        ? msg.dispatchState : 'UNKNOWN';
      error.failure=normalizeFailure(msg.failure,{stage:'TRANSPORT',code:'DISPATCH_FAILED'});
      if(typeof msg.sideEffect==='string')error.sideEffect=msg.sideEffect;
      p.reject(error);
    } else p.resolve(msg.result);
  }
};
