// Offscreen document genuinely uses the WORKERS reason: it spawns a Web Worker.
// It has runtime API access only. It never reads chrome.storage or user tabs.
const worker = new Worker('./transport-worker.js', { type:'module' });
const controlPending = new Map();
let controlSeq = 0;
const CONTROL_ACK_TIMEOUT_MS = 5000;
function controlWorker(operation, token) {
  const requestId = ++controlSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      controlPending.delete(requestId);
      // Unknown delivery is not a successful transport transition.
      resolve({ok:false,reason:'WORKER_CONTROL_ACK_TIMEOUT'});
    },CONTROL_ACK_TIMEOUT_MS);
    controlPending.set(requestId,{resolve,timer,operation});
    try {
      worker.postMessage(operation === 'start'
        ? {type:operation,requestId,token}
        : {type:operation,requestId});
    } catch {
      clearTimeout(timer);
      controlPending.delete(requestId);
      resolve({ok:false,reason:'WORKER_CONTROL_POST_FAILED'});
    }
  });
}
worker.onmessage = async ({data}) => {
  if (data?.type === 'control-ack') {
    const entry=controlPending.get(data.requestId);
    if (!entry || data.operation !== entry.operation) return;
    clearTimeout(entry.timer);
    controlPending.delete(data.requestId);
    entry.resolve({ok:data.ok === true,
      ...(data.ok === true ? {} : {reason:data.reason || 'WORKER_CONTROL_REJECTED'})});
  } else if (data?.type === 'transport-status') {
    await chrome.runtime.sendMessage({target:'bridge-coordinator',type:'transport-status',status:data.status})
      .catch(() => {});
  } else if (data?.type === 'dispatch') {
    try {
      const result = await chrome.runtime.sendMessage({
        target:'bridge-coordinator',type:'dispatch',id:data.id,command:data.command
      });
      worker.postMessage({type:'dispatch-result',id:data.id,...result});
    } catch (error) {
      worker.postMessage({type:'dispatch-result',id:data.id,error:error.message || 'DISPATCH_FAILED'});
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
    void controlWorker('start',message.token).then(sendResponse);
    return true;
  }
  if (message.type === 'stop') {
    void controlWorker('stop').then(sendResponse);
    return true;
  }
  sendResponse({ok:false,reason:'INVALID_OFFSCREEN_CONTROL'});
  return false;
});
