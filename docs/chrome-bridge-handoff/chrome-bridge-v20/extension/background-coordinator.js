import { dispatchReadOnly } from './read-only-dispatch.js';
import { ApprovalSession } from './approval-session.js';
import { dispatchMutation } from './mutation-dispatch.js';
import { BackgroundControlGrants } from './background-control-grants.js';
import { SessionAuthorization } from './session-authorization.js';

const PATH = 'transport-host.html';
let creating = null;
let status = {state:'disconnected',connected:false,error:null,updatedAt:0};
let starting = null;
// Lifecycle generation fences a delayed START against a newer manual STOP.
let lifecycleGeneration = 0;
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

async function readBackgroundControlStatus(chromeApi, bridgeEpoch) {
  const settings=await chromeApi.storage.local.get([
    'bridgeBackgroundMode','bridgeMutationLabMode','bridgeConnectionDesired'
  ]);
  const connection=currentStatus();
  const grants=await new BackgroundControlGrants(chromeApi).activeGrants();
  const sessionAuthorization=await new SessionAuthorization(chromeApi).status(bridgeEpoch);
  return {
    available:true,
    backgroundMode:settings.bridgeBackgroundMode===true,
    mutationEnabled:settings.bridgeMutationLabMode===true,
    connectionDesired:settings.bridgeConnectionDesired===true,
    connected:connection.connected===true,
    connectionState:connection.connected===true ? connection.state :
      connection.state==='connected' ? 'stale' : connection.state,
    grantsKnown:true,
    activeCount:grants.length,
    grants,
    sessionAuthorization,
    approvalPending:approvals.list().length
  };
}

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
  const generation = lifecycleGeneration;
  if (starting?.generation === generation) return starting.promise;
  const promise = startBackgroundTransportOnce(chromeApi, generation).finally(() => {
    if (starting?.promise === promise) starting = null;
  });
  starting = {generation, promise};
  return promise;
}
async function startBackgroundTransportOnce(chromeApi, generation) {
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
  // The panel may be reopened while a manual Stop is pending. Never let an
  // earlier automatic start overtake that Stop after offscreen creation.
  if (generation !== lifecycleGeneration) return {ok:false,reason:'START_SUPERSEDED'};
  const latest = await chromeApi.storage.local.get([
    'bridgeBackgroundMode','bridgeConnectionDesired','browserToken'
  ]);
  if (latest.bridgeBackgroundMode !== true || latest.bridgeConnectionDesired !== true ||
      latest.browserToken !== browserToken || generation !== lifecycleGeneration)
    return {ok:false,reason:'MANUAL_DISCONNECT'};
  await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'start',token:browserToken});
  // If Stop raced the message delivery, issue a final stop so queue ordering
  // cannot leave a late transport running.
  if (generation !== lifecycleGeneration) {
    try { await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'stop'}); } catch {}
    return {ok:false,reason:'START_SUPERSEDED'};
  }
  return {ok:true};
}
export async function stopBackgroundTransport(chromeApi) {
  lifecycleGeneration++;
  starting = null;
  approvals.stop();
  await new BackgroundControlGrants(chromeApi).clear();
  await new SessionAuthorization(chromeApi).revoke();
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
        const sessionAuthorization=new SessionAuthorization(chromeApi);
        if (name==='session_authorize') {
          if (currentStatus().connected!==true) throw Error('BRIDGE_NOT_CONNECTED');
          // Session Authorization must not inherit any stale per-tab grants.
          await new BackgroundControlGrants(chromeApi).clear();
          const lease=await sessionAuthorization.authorize({
            ...msg.command.args,bridgeEpoch:msg.command.bridgeEpoch
          });
          try { await chromeApi.storage.local.set({bridgeMutationLabMode:true}); }
          catch (error) { await sessionAuthorization.revoke(); throw error; }
          return lease;
        }
        if (name==='session_revoke') {
          await sessionAuthorization.revoke();
          await new BackgroundControlGrants(chromeApi).clear();
          await chromeApi.storage.local.set({bridgeMutationLabMode:false});
          return {revoked:true};
        }
        if (name==='session_status') return sessionAuthorization.status(msg.command.bridgeEpoch);
        if (['browser_click','browser_fill','agent_send','provider_prepare','provider_commit'].includes(name)) {
          if (bridgeMutationLabMode!==true) throw Object.assign(Error('BACKGROUND_MUTATIONS_DISABLED'), {dispatchState:'BLOCKED'});
          const grants=new BackgroundControlGrants(chromeApi);
          return dispatchMutation(msg.command,chromeApi,{
            approvals,
            sessionAuthorization,
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
        return dispatchReadOnly(msg.command,chromeApi,{
          getBackgroundControlStatus:()=>readBackgroundControlStatus(chromeApi,msg.command?.bridgeEpoch)
        });
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
      void readBackgroundControlStatus(chromeApi)
        .then(respond,e=>respond({
          available:false,grantsKnown:false,activeCount:null,grants:[],
          error:/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message || '')
            ? e.message : 'BACKGROUND_CONTROL_STATUS_FAILED'
        }));
      return true;
    }
    if (msg.type === 'clear-background-controls') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      void Promise.all([
        new BackgroundControlGrants(chromeApi).clear(),
        new SessionAuthorization(chromeApi).revoke(),
        chromeApi.storage.local.set({bridgeMutationLabMode:false})
      ]).then(()=>respond({ok:true}),e=>respond({error:e.message}));
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
