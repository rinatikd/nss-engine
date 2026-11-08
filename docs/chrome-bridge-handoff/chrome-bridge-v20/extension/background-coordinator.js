import { dispatchReadOnly } from './read-only-dispatch.js';
import { ApprovalSession } from './approval-session.js';
import { dispatchMutation } from './mutation-dispatch.js';
import { BackgroundControlGrants } from './background-control-grants.js';

const PATH = 'transport-host.html';
let creating = null;
let status = {state:'disconnected',connected:false,error:null,updatedAt:0};
let starting = null;
const approvals = new ApprovalSession();
// Extension control.html opened via chrome.windows.create is still a tab.
// Reject web content scripts by requiring the exact extension page URL, not
// by treating sender.tab presence as proof of an untrusted sender.
export const trustedCoordinatorSender = (sender, chromeApi) =>
  sender?.id === chromeApi.runtime.id && (
    sender.url === chromeApi.runtime.getURL('control.html') ||
    (sender.url === chromeApi.runtime.getURL(PATH) && !sender.tab)
  );
const updateStatus = (next) => {
  status = {state:next.state || 'unknown',connected:next.connected === true,
    error:next.error || null,updatedAt:Date.now()};
};
export const currentStatus = () => ({...status,
  // A service worker restart must not report a stale connected state.
  connected: status.connected && (Date.now() - status.updatedAt < 45000)
});

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
  if (starting) return starting;
  starting = startBackgroundTransportOnce(chromeApi).finally(() => { starting = null; });
  return starting;
}
async function startBackgroundTransportOnce(chromeApi) {
  // Restrict access before reading secrets, not after obtaining the key.
  await chromeApi.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const {bridgeConnectionDesired, browserToken} = await chromeApi.storage.local.get(
    ['bridgeConnectionDesired','browserToken']
  );
  const {bridgeBackgroundMode} = await chromeApi.storage.local.get('bridgeBackgroundMode');
  if (bridgeBackgroundMode !== true) return {ok:false,reason:'BACKGROUND_MODE_DISABLED'};
  if (bridgeConnectionDesired !== true) return {ok:false,reason:'MANUAL_DISCONNECT'};
  if (typeof browserToken !== 'string' || !browserToken)
    return {ok:false,reason:'NO_STORED_CREDENTIAL'};
  await ensureHost(chromeApi);
  await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'start',token:browserToken});
  return {ok:true};
}
export async function stopBackgroundTransport(chromeApi) {
  approvals.stop();
  await new BackgroundControlGrants(chromeApi).clear();
  await chromeApi.storage.local.set({
    bridgeConnectionDesired:false,bridgeMutationLabMode:false
  });
  try { await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'stop'}); } catch {}
  updateStatus({state:'disconnected',connected:false});
}
export function installBackgroundCoordinator(chromeApi) {
  chromeApi.runtime.onMessage.addListener((msg,sender,respond) => {
    if (!msg || msg.target !== 'bridge-coordinator' || !trustedCoordinatorSender(sender,chromeApi))
      return false;
    if (msg.type === 'transport-status') {
      // Only the offscreen document can publish connection state.
      if (sender.url !== chromeApi.runtime.getURL(PATH)) { respond({ok:false}); return false; }
      updateStatus(msg.status || {});
      respond({ok:true});
      return false;
    }
    if (msg.type === 'status') {
      respond(currentStatus());
      return false;
    }
    if (msg.type === 'dispatch') {
      if (sender.url !== chromeApi.runtime.getURL(PATH)) {
        respond({error:'OFFSCREEN_CONTEXT_REQUIRED'}); return false;
      }
      const run = async () => {
        const {bridgeBackgroundMode,bridgeMutationLabMode,bridgeConnectionDesired} =
          await chromeApi.storage.local.get([
            'bridgeBackgroundMode','bridgeMutationLabMode','bridgeConnectionDesired'
          ]);
        if (bridgeBackgroundMode!==true || bridgeConnectionDesired!==true)
          throw Error('BACKGROUND_TRANSPORT_DISABLED');
        const name=msg.command?.name;
        if (['browser_click','browser_fill','agent_send'].includes(name)) {
          if (bridgeMutationLabMode!==true) throw Object.assign(Error('BACKGROUND_MUTATIONS_DISABLED'), {dispatchState:'BLOCKED'});
          const grants=new BackgroundControlGrants(chromeApi);
          return dispatchMutation(msg.command,chromeApi,{
            approvals,
            controlGrant:(origin,tabId)=>grants.require(origin,tabId),
            stillEnabled:async()=>{
              const settings=await chromeApi.storage.local.get([
                'bridgeBackgroundMode','bridgeMutationLabMode','bridgeConnectionDesired'
              ]);
              return settings.bridgeBackgroundMode===true &&
                settings.bridgeMutationLabMode===true &&
                settings.bridgeConnectionDesired===true;
            }
          });
        }
        return dispatchReadOnly(msg.command,chromeApi);
      };
      void run().then(result=>respond({result}),e=>respond({
        error:e.message,
        // Only the trusted coordinator can assert no DOM execution occurred.
        dispatchState:['BLOCKED','NOT_PERFORMED'].includes(e.dispatchState)
          ? e.dispatchState : 'UNKNOWN'
      }));
      return true;
    }
    if (msg.type === 'background-control-status') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      void new BackgroundControlGrants(chromeApi).activeCount()
        .then(activeCount=>respond({activeCount}),e=>respond({error:e.message}));
      return true;
    }
    if (msg.type === 'clear-background-controls') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      void new BackgroundControlGrants(chromeApi).clear()
        .then(()=>respond({ok:true}),e=>respond({error:e.message}));
      return true;
    }
    if (msg.type === 'grant-background-control' || msg.type === 'revoke-background-control') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      const run=async()=>{
        const grants=new BackgroundControlGrants(chromeApi);
        if (msg.type==='revoke-background-control') {
          await grants.revoke(msg.tabId);return {ok:true};
        }
        const {bridgeMutationLabMode,bridgeConnectionDesired}=await chromeApi.storage.local.get(
          ['bridgeMutationLabMode','bridgeConnectionDesired']);
        if(bridgeMutationLabMode!==true || bridgeConnectionDesired!==true)
          throw Error('BACKGROUND_CONTROL_DISABLED');
        return grants.grant({
          tabId:msg.tabId,durationMinutes:msg.durationMinutes,localGesture:msg.localGesture===true
        });
      };
      void run().then(respond,e=>respond({error:e.message}));
      return true;
    }
    if (msg.type === 'approval-list') {
      // Pending metadata only, never full prompts, tokens or selectors.
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      respond({pending:approvals.list()}); return false;
    }
    if (msg.type === 'approval-decide') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      // This is only the approval-dialog transport. No execution path is
      // activated in the background executor until identity revalidation lands.
      try {
        respond(approvals.decide({
          id:msg.id, approved:msg.approved===true, trustedUserGesture:msg.trustedUserGesture===true
        }));
      } catch(e) { respond({error:e.message}); }
      return false;
    }
    if (msg.type === 'start-background') {
      void startBackgroundTransport(chromeApi).then(respond, e => respond({ok:false,reason:e.message}));
      return true;
    }
    if (msg.type === 'stop-background') {
      void stopBackgroundTransport(chromeApi).then(() => respond({ok:true}),e=>respond({ok:false,reason:e.message}));
      return true;
    }
    return false;
  });
}
