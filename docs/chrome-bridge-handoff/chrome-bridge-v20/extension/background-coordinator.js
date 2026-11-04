import { dispatchReadOnly } from './read-only-dispatch.js';

const PATH = 'transport-host.html';
let creating = null;
let status = {state:'disconnected',connected:false,error:null};

async function ensureHost(chromeApi) {
  if (!chromeApi.offscreen?.createDocument || !chromeApi.runtime?.getContexts)
    throw Error('OFFSCREEN_UNAVAILABLE');
  const existing = await chromeApi.runtime.getContexts({
    contextTypes:['OFFSCREEN_DOCUMENT'],
    documentUrls:[chromeApi.runtime.getURL(PATH)]
  });
  if (existing.length) return;
  if (!creating) {
    // WORKERS is legitimate here because transport-host.js starts a Worker.
    creating = chromeApi.offscreen.createDocument({
      url:PATH,
      reasons:['WORKERS'],
      justification:'Hosts the separate Chrome Bridge HTTP polling Worker while the control panel is closed'
    }).finally(() => { creating=null; });
  }
  await creating;
}
export async function startBackgroundTransport(chromeApi) {
  const {bridgeConnectionDesired, browserToken} = await chromeApi.storage.local.get(
    ['bridgeConnectionDesired','browserToken']
  );
  if (bridgeConnectionDesired !== true) return {ok:false,reason:'MANUAL_DISCONNECT'};
  if (typeof browserToken !== 'string' || !browserToken)
    return {ok:false,reason:'NO_STORED_CREDENTIAL'};
  await chromeApi.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await ensureHost(chromeApi);
  await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'start',token:browserToken});
  return {ok:true};
}
export async function stopBackgroundTransport(chromeApi) {
  await chromeApi.storage.local.set({bridgeConnectionDesired:false});
  try { await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'stop'}); } catch {}
  status={state:'disconnected',connected:false,error:null};
}
export function installBackgroundCoordinator(chromeApi) {
  chromeApi.runtime.onMessage.addListener((msg,sender,respond) => {
    if (!msg || msg.target !== 'bridge-coordinator' || sender.id !== chromeApi.runtime.id)
      return false;
    if (msg.type === 'transport-status') {
      status = {state:msg.status?.state || 'unknown',connected:msg.status?.connected===true,
        error:msg.status?.error || null};
      respond({ok:true});
      return false;
    }
    if (msg.type === 'status') {
      respond({...status});
      return false;
    }
    if (msg.type === 'dispatch') {
      Promise.resolve().then(() => dispatchReadOnly(msg.command,chromeApi))
        .then(result=>respond({result}),e=>respond({error:e.message}));
      return true;
    }
    return false;
  });
}
