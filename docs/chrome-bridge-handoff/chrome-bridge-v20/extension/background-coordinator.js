import { dispatchReadOnly } from './read-only-dispatch.js';
import { ApprovalSession } from './approval-session.js';
import { dispatchMutation } from './mutation-dispatch.js';
import { dispatchOneClickMutation } from './one-click-mutation.js';
import { dispatchOneClickNavigation } from './one-click-navigation.js';
import { BackgroundControlGrants } from './background-control-grants.js';

const PATH = 'transport-host.html';
let creating = null;
let status = {state:'disconnected',connected:false,error:null,updatedAt:0};
let starting = null;
// Invalidates a positive status check that was queued before Disconnect.
let disconnectEpoch = 0;
const approvals = new ApprovalSession();
// Accepted one-click mutations are serialized per tab. Stop fences new work
// synchronously, then drains every lane before it can acknowledge success.
const mutationLanes = new Map();
const mutationFencedTabs = new Map();
let mutationStopRequested = false;
let mutationStopCount = 0;
const STOP_DRAIN_TIMEOUT_MS = 5000;

function enqueueTabMutation(tabId, task) {
  if (mutationStopRequested) throw Error('BACKGROUND_STOP_IN_PROGRESS');
  if (mutationFencedTabs.has(tabId)) throw Error('TAB_MUTATION_REVOKING');
  const previous = mutationLanes.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    if (mutationStopRequested) throw Error('BACKGROUND_STOP_IN_PROGRESS');
    if (mutationFencedTabs.has(tabId)) throw Error('TAB_MUTATION_REVOKING');
    return task();
  });
  mutationLanes.set(tabId, next);
  void next.finally(() => {
    if (mutationLanes.get(tabId) === next) mutationLanes.delete(tabId);
  }).catch(() => {});
  return next;
}

async function drainMutationLanes(chromeApi) {
  const entries = [...mutationLanes.entries()];
  if (!entries.length) return true;
  let timer;
  const drained = Promise.allSettled(entries.map(([,pending]) => pending)).then(() => true);
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), STOP_DRAIN_TIMEOUT_MS);
  });
  const clean = await Promise.race([drained, timeout]);
  clearTimeout(timer);
  if (clean) return true;
  // Persist quarantine so a service-worker restart cannot silently reopen
  // a tab whose accepted page action did not drain within the bound.
  const tabIds = entries.map(([tabId]) => tabId);
  try {
    const state = await chromeApi.storage.local.get('bridgeMutationQuarantinedTabs');
    const prior = Array.isArray(state.bridgeMutationQuarantinedTabs)
      ? state.bridgeMutationQuarantinedTabs : [];
    await chromeApi.storage.local.set({
      bridgeMutationQuarantinedTabs:[...new Set([...prior,...tabIds])]
    });
  } catch { /* the caller must still report an unconfirmed Stop */ }
  return false;
}
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
  const expectedEpoch = disconnectEpoch;
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
  // ensureHost is asynchronous: a user can disconnect while Chrome creates
  // the offscreen document. Re-read persistent intent immediately before start.
  const latest = await chromeApi.storage.local.get([
    'bridgeBackgroundMode','bridgeConnectionDesired'
  ]);
  if (latest.bridgeBackgroundMode !== true || latest.bridgeConnectionDesired !== true)
    return {ok:false,reason:'MANUAL_DISCONNECT_DURING_START'};
  const acknowledged = await chromeApi.runtime.sendMessage({
    target:'bridge-offscreen',type:'start',token:browserToken
  });
  if (acknowledged?.ok !== true)
    return {ok:false,reason:'BACKGROUND_START_UNCONFIRMED'};
  // A Disconnect can overtake the worker acknowledgement. Do not report
  // success from an obsolete start even if the Worker briefly accepted it.
  if (disconnectEpoch !== expectedEpoch)
    return {ok:false,reason:'BACKGROUND_START_SUPERSEDED_BY_DISCONNECT'};
  const finalIntent = await chromeApi.storage.local.get([
    'bridgeBackgroundMode','bridgeConnectionDesired'
  ]);
  if (disconnectEpoch !== expectedEpoch ||
      finalIntent.bridgeBackgroundMode !== true ||
      finalIntent.bridgeConnectionDesired !== true)
    return {ok:false,reason:'BACKGROUND_START_SUPERSEDED_BY_DISCONNECT'};
  if (mutationStopCount > 0)
    return {ok:false,reason:'BACKGROUND_STOP_IN_PROGRESS'};
  mutationStopRequested = false;
  return {ok:true};
}
export async function stopBackgroundTransport(chromeApi) {
  // Fence accepted-work admission before the first await. No mutation may
  // enter a lane after Stop has begun.
  mutationStopRequested = true;
  mutationStopCount += 1;
  try {
  // Fence pending positive status notifications before the first await.
  ++disconnectEpoch;
  updateStatus({state:'disconnected',connected:false});
  // Disable dispatch *before* any potentially failing asynchronous cleanup.
  // Persist the stop intent first so a concurrent keepalive cannot reconnect.
  await chromeApi.storage.local.set({
    bridgeConnectionDesired:false,bridgeMutationLabMode:false,bridgeAllTabsMode:false
  });
  approvals.stop();
  let cleanupError = null;
  try { await new BackgroundControlGrants(chromeApi).clear(); }
  catch (error) { cleanupError = error; }
  // Attempt the offscreen stop even when stale-grant cleanup failed.
  // A failed message is only harmless when Chrome proves the offscreen host
  // does not exist. Otherwise NEVER falsely acknowledge a stopped transport.
  let stopUnconfirmed = false;
  try {
    const ack = await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'stop'});
    if (ack?.ok !== true) stopUnconfirmed = true;
  } catch {
    try {
      if (typeof chromeApi.runtime?.getContexts !== 'function') {
        stopUnconfirmed = true;
      } else {
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes:['OFFSCREEN_DOCUMENT'],
          documentUrls:[chromeApi.runtime.getURL(PATH)]
        });
        if (!Array.isArray(contexts) || contexts.length > 0) stopUnconfirmed = true;
      }
    } catch { stopUnconfirmed = true; }
  }
  // Offscreen ACK is not an end-to-end Stop ACK. Wait for every mutation
  // accepted before the fence; otherwise the page may click Send after Stop.
  const mutationsDrained = await drainMutationLanes(chromeApi);
  if (!mutationsDrained) stopUnconfirmed = true;
  updateStatus({state:'disconnected',connected:false,
    error:stopUnconfirmed ? 'BACKGROUND_STOP_UNCONFIRMED' : null});
  if (stopUnconfirmed) throw Error('BACKGROUND_STOP_UNCONFIRMED');
  if (cleanupError) throw Error('BACKGROUND_GRANT_CLEANUP_FAILED');
  } finally {
    mutationStopCount = Math.max(0,mutationStopCount - 1);
  }
}
export function installBackgroundCoordinator(chromeApi) {
  chromeApi.runtime.onMessage.addListener((msg,sender,respond) => {
    if (!msg || msg.target !== 'bridge-coordinator' || !trustedCoordinatorSender(sender,chromeApi))
      return false;
    if (msg.type === 'transport-status') {
      // Only the offscreen document can publish connection state.
      if (sender.url !== chromeApi.runtime.getURL(PATH)) { respond({ok:false}); return false; }
      // A delayed 'connected' notification may arrive after Disconnect.
      // Authorize positive connection state against persistent session intent;
      // the offscreen sender identity alone does not imply an active grant.
      if (msg.status?.connected === true) {
        const expectedEpoch = disconnectEpoch;
        void chromeApi.storage.local.get([
          'bridgeBackgroundMode','bridgeConnectionDesired','bridgeAllTabsMode',
          'bridgeMutationLabMode'
        ]).then(flags => {
          if (disconnectEpoch !== expectedEpoch ||
              flags.bridgeBackgroundMode !== true ||
              flags.bridgeConnectionDesired !== true ||
              flags.bridgeAllTabsMode !== true ||
              flags.bridgeMutationLabMode !== true) {
            updateStatus({state:'disconnected',connected:false});
            respond({ok:false,reason:'SESSION_NOT_ACTIVE'});
            return;
          }
          updateStatus(msg.status);
          respond({ok:true});
        }, () => {
          // Storage is the source of truth: a read failure must not leave
          // an old 'connected' badge visible in coordinator memory.
          updateStatus({state:'disconnected',connected:false,
            error:'SESSION_STATE_UNAVAILABLE'});
          respond({ok:false,reason:'SESSION_STATE_UNAVAILABLE'});
        });
        return true;
      }
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
        const {bridgeBackgroundMode,bridgeMutationLabMode,bridgeConnectionDesired,bridgeAllTabsMode,
          bridgeMutationQuarantinedTabs} = await chromeApi.storage.local.get([
            'bridgeBackgroundMode','bridgeMutationLabMode','bridgeConnectionDesired','bridgeAllTabsMode',
            'bridgeMutationQuarantinedTabs'
          ]);
        if (bridgeBackgroundMode!==true || bridgeConnectionDesired!==true)
          throw Error('BACKGROUND_TRANSPORT_DISABLED');
        const name=msg.command?.name;
        if (bridgeAllTabsMode===true && ['browser_open','agent_new_chat'].includes(name)) {
          return dispatchOneClickNavigation(msg.command,chromeApi);
        }
        if (['browser_click','browser_fill','agent_send'].includes(name)) {
          if (bridgeMutationLabMode!==true) throw Error('BACKGROUND_MUTATIONS_DISABLED');
          const tabId = msg.command?.args?.tabId;
          if (Array.isArray(bridgeMutationQuarantinedTabs) &&
              bridgeMutationQuarantinedTabs.includes(tabId))
            throw Error('TAB_MUTATION_QUARANTINED');
          if (bridgeAllTabsMode===true) return dispatchOneClickMutation(msg.command,chromeApi);
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
        return dispatchReadOnly(msg.command,chromeApi,{transportStatus:currentStatus()});
      };
      const mutation = ['browser_click','browser_fill','agent_send'].includes(msg.command?.name);
      if (mutation) {
        const tabId = msg.command?.args?.tabId;
        if (!Number.isSafeInteger(tabId)) {
          respond({error:'INVALID_MUTATION_TAB'});
          return false;
        }
        let accepted;
        try {
          accepted = enqueueTabMutation(tabId, run);
        } catch (error) {
          respond({error:error.message});
          return false;
        }
        void accepted.then(result=>respond({result}),e=>respond({error:e.message}));
      } else {
        void run().then(result=>respond({result}),e=>respond({error:e.message}));
      }
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
          if (!Number.isSafeInteger(msg.tabId)) throw Error('INVALID_TAB_ID');
          mutationFencedTabs.set(msg.tabId,(mutationFencedTabs.get(msg.tabId) || 0) + 1);
          try {
            const pending = mutationLanes.get(msg.tabId);
            if (pending) await pending.catch(() => {});
            await grants.revoke(msg.tabId);
            return {ok:true};
          } finally {
            const remaining = (mutationFencedTabs.get(msg.tabId) || 1) - 1;
            if (remaining > 0) mutationFencedTabs.set(msg.tabId,remaining);
            else mutationFencedTabs.delete(msg.tabId);
          }
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
      void stopBackgroundTransport(chromeApi).then(
        () => respond({ok:true}),
        e => respond({ok:false,reason:e.message,
          ...(e.message === 'BACKGROUND_STOP_UNCONFIRMED' ? {outcome:'UNKNOWN'} : {})})
      );
      return true;
    }
    return false;
  });
}
