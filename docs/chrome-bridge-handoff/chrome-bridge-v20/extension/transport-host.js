// Offscreen document genuinely uses the WORKERS reason: it spawns a Web Worker.
// It has runtime API access only. It never reads chrome.storage or user tabs.
const worker = new Worker('./transport-worker.js', { type:'module' });
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
      worker.postMessage({type:'dispatch-result',id:data.id,error:error.message || 'DISPATCH_FAILED'});
    }
  }
};
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (message?.target !== 'bridge-offscreen') return false;
  if (sender.id !== chrome.runtime.id) { sendResponse({ok:false}); return false; }
  if (message.type === 'start' && typeof message.token === 'string') {
    worker.postMessage({type:'start',token:message.token});
    sendResponse({ok:true});
  } else if (message.type === 'stop') {
    worker.postMessage({type:'stop'});
    sendResponse({ok:true});
  }
  return false;
});
