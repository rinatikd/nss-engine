import { makeFailure } from './failure-contract.js';

// Offscreen document genuinely uses the WORKERS reason: it spawns a Web Worker.
// It has runtime API access only. It never reads chrome.storage or user tabs.
const worker = new Worker('./transport-worker.js', { type:'module' });
const stopWaiters = new Map();
let stopRequestSequence = 0;
const STOP_ACK_TIMEOUT_MS = 5000;

worker.onmessage = async ({data}) => {
  if (data?.type === 'transport-status') {
    await chrome.runtime.sendMessage({target:'bridge-coordinator',type:'transport-status',status:data.status})
      .catch(() => {});
  } else if (data?.type === 'dispatch') {
    try {
      const result = await chrome.runtime.sendMessage({
        target:'bridge-coordinator',type:'dispatch',id:data.id,command:data.command
      });
      worker.postMessage({type:'dispatch-result',id:data.id,...result});
    } catch (error) {
      worker.postMessage({type:'dispatch-result',id:data.id,error:'COORDINATOR_UNAVAILABLE',
        dispatchState:'UNKNOWN',failure:makeFailure('TRANSPORT','COORDINATOR_UNAVAILABLE')});
    }
  } else if (data?.type === 'stopped') {
    const waiter = stopWaiters.get(data.stopId);
    if (waiter) {
      clearTimeout(waiter.timer);
      stopWaiters.delete(data.stopId);
      waiter.sendResponse({ok:true});
    }
  }
};
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (message?.target !== 'bridge-offscreen') return false;
  // Content scripts carry the same extension ID: reject any sender from a tab.
  if (sender.id !== chrome.runtime.id || sender.tab) {
    sendResponse({ok:false}); return false;
  }
  if (message.type === 'start' && typeof message.token === 'string') {
    worker.postMessage({type:'start',token:message.token});
    sendResponse({ok:true});
  } else if (message.type === 'stop') {
    const stopId = ++stopRequestSequence;
    const timer = setTimeout(() => {
      stopWaiters.delete(stopId);
      sendResponse({ok:false,reason:'WORKER_STOP_UNCONFIRMED'});
    }, STOP_ACK_TIMEOUT_MS);
    stopWaiters.set(stopId,{sendResponse,timer});
    try {
      worker.postMessage({type:'stop',stopId});
    } catch {
      clearTimeout(timer);
      stopWaiters.delete(stopId);
      sendResponse({ok:false,reason:'WORKER_STOP_UNCONFIRMED'});
    }
    return true;
  }
  return false;
});
