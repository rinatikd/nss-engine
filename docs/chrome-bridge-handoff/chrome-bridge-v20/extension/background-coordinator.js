import { dispatchReadOnly, permittedTab } from './read-only-dispatch.js';
import { ApprovalSession } from './approval-session.js';
import { dispatchMutation } from './mutation-dispatch.js';
import { BackgroundControlGrants } from './background-control-grants.js';
import { SessionAuthorization } from './session-authorization.js';
import { normalizeFailure } from './failure-contract.js';

const PATH = 'transport-host.html';
let creating = null;
let status = {state:'disconnected',connected:false,error:null,updatedAt:0};
let starting = null;
// Lifecycle generation fences a delayed START against a newer manual STOP.
let lifecycleGeneration = 0;
const approvals = new ApprovalSession();

const MUTATION_COMMANDS = new Set([
  'browser_click','browser_fill','agent_send','provider_prepare','provider_commit'
]);
const STOP_DRAIN_TIMEOUT_MS = 5000;
const START_DRAIN_TIMEOUT_MS = 5000;
const mutationLanes = new Map();
const mutationFencedTabs = new Map();
const mutationQuarantinedTabs = new Set();
let mutationStopRequested = false;
let mutationStopCount = 0;
let mutationQuarantinePersistenceFailed = false;
let controlStorageLane = Promise.resolve();
let controlClearRequested = false;
let controlClearFailed = false;

function coordinatorError(code, dispatchState='NOT_PERFORMED') {
  return Object.assign(Error(code), {dispatchState});
}

// Grants, Revoke and global clear all mutate the same session-storage object.
// One FIFO prevents stale read/modify/write snapshots from overwriting each other.
function enqueueControlOperation(task, {
  tabId=null, allowDuringClear=false, allowFencedTab=false
}={}) {
  if (!allowFencedTab && tabId !== null && mutationFencedTabs.has(tabId))
    throw coordinatorError('TAB_CONTROL_REVOKING');
  if (!allowDuringClear && mutationStopRequested)
    throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
  if (!allowDuringClear && controlClearFailed)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
  if (!allowDuringClear && controlClearRequested)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');

  const next = controlStorageLane.catch(() => {}).then(() => {
    if (!allowFencedTab && tabId !== null && mutationFencedTabs.has(tabId))
      throw coordinatorError('TAB_CONTROL_REVOKING');
    if (!allowDuringClear && mutationStopRequested)
      throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
    if (!allowDuringClear && controlClearFailed)
      throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
    if (!allowDuringClear && controlClearRequested)
      throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');
    return task();
  });
  controlStorageLane = next;
  void next.catch(() => {});
  return next;
}

function enqueueTabMutation(tabId, task) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0)
    throw coordinatorError('INVALID_MUTATION_TAB');
  if (mutationStopRequested)
    throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
  if (controlClearFailed)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
  if (controlClearRequested)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');
  if (mutationQuarantinePersistenceFailed)
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE');
  if (mutationFencedTabs.has(tabId))
    throw coordinatorError('TAB_MUTATION_REVOKING');
  if (mutationQuarantinedTabs.has(tabId))
    throw coordinatorError('TAB_MUTATION_QUARANTINED');

  const previous = mutationLanes.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    if (mutationStopRequested)
      throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
    if (controlClearFailed)
      throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
    if (controlClearRequested)
      throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');
    if (mutationQuarantinePersistenceFailed)
      throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE');
    if (mutationFencedTabs.has(tabId))
      throw coordinatorError('TAB_MUTATION_REVOKING');
    if (mutationQuarantinedTabs.has(tabId))
      throw coordinatorError('TAB_MUTATION_QUARANTINED');
    return task();
  });
  mutationLanes.set(tabId, next);
  void next.finally(() => {
    if (mutationLanes.get(tabId) === next) mutationLanes.delete(tabId);
  }).catch(() => {});
  return next;
}

async function assertMutationAllowed(chromeApi, tabId) {
  if (mutationStopRequested)
    throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
  if (controlClearFailed)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
  if (controlClearRequested)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS');
  if (mutationQuarantinePersistenceFailed)
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE');

  const local = await chromeApi.storage.local.get([
    'bridgeMutationQuarantinedTabs','bridgeMutationQuarantineLock'
  ]);
  let session = {};
  if (chromeApi.storage.session?.get) {
    session = await chromeApi.storage.session.get([
      'bridgeMutationQuarantinedTabs','bridgeMutationQuarantineLock'
    ]);
  }
  if (local.bridgeMutationQuarantineLock === true ||
      session.bridgeMutationQuarantineLock === true)
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE');

  const localTabs = Array.isArray(local.bridgeMutationQuarantinedTabs)
    ? local.bridgeMutationQuarantinedTabs : [];
  const sessionTabs = Array.isArray(session.bridgeMutationQuarantinedTabs)
    ? session.bridgeMutationQuarantinedTabs : [];
  for (const id of [...localTabs,...sessionTabs]) {
    if (Number.isSafeInteger(id) && id > 0) mutationQuarantinedTabs.add(id);
  }
  if (mutationQuarantinedTabs.has(tabId) ||
      localTabs.includes(tabId) || sessionTabs.includes(tabId))
    throw coordinatorError('TAB_MUTATION_QUARANTINED');
}

async function persistMutationQuarantine(chromeApi, tabIds) {
  for (const tabId of tabIds) mutationQuarantinedTabs.add(tabId);
  try {
    const state = await chromeApi.storage.local.get('bridgeMutationQuarantinedTabs');
    const prior = Array.isArray(state.bridgeMutationQuarantinedTabs)
      ? state.bridgeMutationQuarantinedTabs : [];
    await chromeApi.storage.local.set({
      bridgeMutationQuarantinedTabs:[...new Set([...prior,...tabIds])]
    });
    return {persisted:true,store:'local'};
  } catch {
    // chrome.storage.session survives an MV3 service-worker restart; local is
    // preferred because its quarantine survives a browser restart as well.
    try {
      const state = await chromeApi.storage.session.get('bridgeMutationQuarantinedTabs');
      const prior = Array.isArray(state.bridgeMutationQuarantinedTabs)
        ? state.bridgeMutationQuarantinedTabs : [];
      await chromeApi.storage.session.set({
        bridgeMutationQuarantinedTabs:[...new Set([...prior,...tabIds])]
      });
      return {persisted:true,store:'session'};
    } catch {
      mutationQuarantinePersistenceFailed = true;
      // Try to leave a durable global deny marker. If both stores are down,
      // the current worker remains fail-closed but restart recovery is UNKNOWN.
      try {
        await chromeApi.storage.local.set({bridgeMutationQuarantineLock:true});
      } catch {
        try {
          await chromeApi.storage.session.set({bridgeMutationQuarantineLock:true});
        } catch { /* no durable storage path remains */ }
      }
      return {persisted:false,store:null};
    }
  }
}

async function drainMutationLanes(chromeApi, timeoutMs=STOP_DRAIN_TIMEOUT_MS) {
  const entries = [...mutationLanes.entries()];
  if (!entries.length) return {drained:true,tabIds:[],quarantinePersisted:true};
  let timer;
  const drained = Promise.allSettled(entries.map(([,pending]) => pending)).then(() => true);
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const clean = await Promise.race([drained,timeout]);
  clearTimeout(timer);
  if (clean) return {drained:true,tabIds:[],quarantinePersisted:true};
  const tabIds = entries.map(([tabId]) => tabId);
  const persisted = await persistMutationQuarantine(chromeApi,tabIds);
  return {drained:false,tabIds,quarantinePersisted:persisted.persisted};
}

async function awaitBounded(promise, timeoutMs) {
  if (!promise) return true;
  let timer;
  const settled = await Promise.race([
    Promise.resolve(promise).then(() => true,() => true),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(false),timeoutMs);
    })
  ]);
  clearTimeout(timer);
  return settled;
}

async function clearAllBackgroundControls(chromeApi) {
  await new BackgroundControlGrants(chromeApi).clear();
  await new SessionAuthorization(chromeApi).revoke();
  await chromeApi.storage.local.set({bridgeMutationLabMode:false});
}

async function stopOffscreenTransport(chromeApi) {
  try {
    const ack = await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'stop'});
    if (ack?.ok === true) return true;
  } catch { /* verify whether the offscreen host is already absent */ }
  try {
    if (typeof chromeApi.runtime?.getContexts !== 'function') return false;
    const contexts = await chromeApi.runtime.getContexts({
      contextTypes:['OFFSCREEN_DOCUMENT'],
      documentUrls:[chromeApi.runtime.getURL(PATH)]
    });
    return Array.isArray(contexts) && contexts.length === 0;
  } catch {
    return false;
  }
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
  if (mutationStopCount > 0 || controlClearRequested)
    return {ok:false,reason:'BACKGROUND_STOP_IN_PROGRESS'};
  if (controlClearFailed)
    return {ok:false,reason:'BACKGROUND_CONTROL_CLEAR_FAILED'};
  if (mutationQuarantinePersistenceFailed)
    return {ok:false,reason:'MUTATION_QUARANTINE_STATE_UNAVAILABLE'};
  const generation = lifecycleGeneration;
  if (starting?.generation === generation) return starting.promise;
  const promise = startBackgroundTransportOnce(chromeApi, generation).finally(() => {
    if (starting?.promise === promise) starting = null;
  });
  starting = {generation, promise};
  return promise;
}
async function startBackgroundTransportOnce(chromeApi, generation) {
  if (mutationStopCount > 0 || controlClearRequested)
    return {ok:false,reason:'BACKGROUND_STOP_IN_PROGRESS'};
  if (controlClearFailed)
    return {ok:false,reason:'BACKGROUND_CONTROL_CLEAR_FAILED'};
  if (mutationQuarantinePersistenceFailed)
    return {ok:false,reason:'MUTATION_QUARANTINE_STATE_UNAVAILABLE'};
  await controlStorageLane.catch(() => {});
  if (controlClearRequested || controlClearFailed || mutationStopCount > 0)
    return {ok:false,reason:'BACKGROUND_STOP_IN_PROGRESS'};
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
  if (generation !== lifecycleGeneration || mutationStopCount > 0)
    return {ok:false,reason:'START_SUPERSEDED'};
  const latest = await chromeApi.storage.local.get([
    'bridgeBackgroundMode','bridgeConnectionDesired','browserToken'
  ]);
  if (latest.bridgeBackgroundMode !== true || latest.bridgeConnectionDesired !== true ||
      latest.browserToken !== browserToken || generation !== lifecycleGeneration)
    return {ok:false,reason:'MANUAL_DISCONNECT'};
  await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'start',token:browserToken});
  // If Stop raced the message delivery, issue a final stop so queue ordering
  // cannot leave a late transport running.
  if (generation !== lifecycleGeneration || mutationStopCount > 0) {
    try { await chromeApi.runtime.sendMessage({target:'bridge-offscreen',type:'stop'}); } catch {}
    return {ok:false,reason:'START_SUPERSEDED'};
  }
  // Only a new, explicitly requested successful Start reopens mutation admission.
  mutationStopRequested = false;
  controlClearRequested = false;
  return {ok:true};
}
export async function stopBackgroundTransport(chromeApi, {
  stopDrainTimeoutMs=STOP_DRAIN_TIMEOUT_MS,
  startDrainTimeoutMs=START_DRAIN_TIMEOUT_MS
}={}) {
  const pendingStart = starting?.promise || null;
  // Fence mutation and grant admission synchronously, before the first await.
  mutationStopRequested = true;
  controlClearRequested = true;
  mutationStopCount += 1;
  lifecycleGeneration++;
  starting = null;
  approvals.stop();
  updateStatus({state:'stopping',connected:false,error:null});

  let intentPersisted = true;
  try {
    // Persist the stop intent before cleanup so an MV3 worker restart cannot
    // re-open the mutation path from stale desired-state flags.
    await chromeApi.storage.local.set({
      bridgeConnectionDesired:false,bridgeMutationLabMode:false
    });
  } catch {
    intentPersisted = false;
    try {
      await chromeApi.storage.session.set({bridgeMutationQuarantineLock:true});
    } catch {
      mutationQuarantinePersistenceFailed = true;
    }
  }

  let cleanupError = null;
  try {
    await enqueueControlOperation(
      () => clearAllBackgroundControls(chromeApi),
      {allowDuringClear:true}
    );
    controlClearFailed = false;
  } catch (error) {
    controlClearFailed = true;
    cleanupError = error;
  }

  // A Start accepted before Stop may still be creating the offscreen document
  // or sending its START message. Drain it first, then send the final STOP.
  const startDrained = await awaitBounded(pendingStart,startDrainTimeoutMs);
  const mutationDrain = await drainMutationLanes(chromeApi,stopDrainTimeoutMs);
  const stopConfirmed = await stopOffscreenTransport(chromeApi);

  const unknown = !intentPersisted || !startDrained ||
    !mutationDrain.drained || !stopConfirmed;
  if (!stopConfirmed || !startDrained || !mutationDrain.drained || cleanupError || !intentPersisted) {
    const code = !stopConfirmed || !startDrained || !mutationDrain.drained || !intentPersisted
      ? 'BACKGROUND_STOP_UNCONFIRMED' : 'BACKGROUND_CONTROL_CLEAR_FAILED';
    updateStatus({state:'unknown',connected:false,error:code});
    const error = Error(code);
    error.outcome = unknown ? 'UNKNOWN' : 'NOT_PERFORMED';
    if (mutationDrain.tabIds.length) error.quarantinedTabs = mutationDrain.tabIds;
    throw error;
  }

  updateStatus({state:'disconnected',connected:false,error:null});
  return {ok:true,quarantinedTabs:[]};
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
        const failureStartedAt=Date.now();
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
          ? e.dispatchState : 'UNKNOWN',
        failure:normalizeFailure(e?.failure,{stage:'PRECHECK',
          code:/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message||'')?e.message:'COORDINATOR_DISPATCH_FAILED',
          startedAt:failureStartedAt})
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
