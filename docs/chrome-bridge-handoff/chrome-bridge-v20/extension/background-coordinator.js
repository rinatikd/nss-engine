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

  const localRevoking = Array.isArray(local.bridgeMutationRevokingTabs)
    ? local.bridgeMutationRevokingTabs : [];
  const sessionRevoking = Array.isArray(session.bridgeMutationRevokingTabs)
    ? session.bridgeMutationRevokingTabs : [];
  if (localRevoking.includes(tabId) || sessionRevoking.includes(tabId))
    throw coordinatorError('TAB_MUTATION_REVOKING');

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

// A Revoke fence must survive MV3 worker suspension while the accepted tab
// lane drains. The marker is removed only after the grant-store revoke is
// confirmed; a restarted worker therefore rejects new page actions.
async function persistTabRevocationFence(chromeApi, tabId) {
  const key = 'bridgeMutationRevokingTabs';
  try {
    const state = await chromeApi.storage.local.get(key);
    const prior = Array.isArray(state[key]) ? state[key] : [];
    if (prior.includes(tabId)) return {persisted:true,store:'local'};
    await chromeApi.storage.local.set({[key]:[...new Set([...prior,tabId])]});
    return {persisted:true,store:'local'};
  } catch {
    try {
      const state = await chromeApi.storage.session.get(key);
      const prior = Array.isArray(state[key]) ? state[key] : [];
      if (prior.includes(tabId)) return {persisted:true,store:'session'};
      await chromeApi.storage.session.set({[key]:[...new Set([...prior,tabId])]});
      return {persisted:true,store:'session'};
    } catch {
      mutationQuarantinePersistenceFailed = true;
      return {persisted:false,store:null};
    }
  }
}

async function clearTabRevocationFence(chromeApi, tabId, store) {
  const storage = store === 'local' ? chromeApi.storage.local :
    store === 'session' ? chromeApi.storage.session : null;
  if (!storage?.get || !storage?.set) return false;
  const key = 'bridgeMutationRevokingTabs';
  const state = await storage.get(key);
  const prior = Array.isArray(state[key]) ? state[key] : [];
  await storage.set({[key]:prior.filter(id=>id!==tabId)});
  return true;
}

async function persistGlobalQuarantineLock(chromeApi) {
  try {
    await chromeApi.storage.local.set({bridgeMutationQuarantineLock:true});
    return {persisted:true,store:'local'};
  } catch {
    try {
      await chromeApi.storage.session.set({bridgeMutationQuarantineLock:true});
      return {persisted:true,store:'session'};
    } catch {
      mutationQuarantinePersistenceFailed = true;
      return {persisted:false,store:null};
    }
  }
}

async function assertNoGlobalQuarantineLock(chromeApi) {
  if (mutationQuarantinePersistenceFailed)
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','BLOCKED');
  let local,session;
  try {
    local=await chromeApi.storage.local.get('bridgeMutationQuarantineLock');
    session=await chromeApi.storage.session.get('bridgeMutationQuarantineLock');
  } catch {
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','BLOCKED');
  }
  if (local.bridgeMutationQuarantineLock===true ||
      session.bridgeMutationQuarantineLock===true)
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','BLOCKED');
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

async function enqueueControlOperationBounded(task, options={}, timeoutMs=STOP_DRAIN_TIMEOUT_MS) {
  const pending = enqueueControlOperation(task,options);
  let timer;
  const outcome = await Promise.race([
    pending.then(value=>({settled:true,value}),error=>({settled:true,error})),
    new Promise(resolve=>{
      timer=setTimeout(()=>resolve({settled:false}),timeoutMs);
    })
  ]);
  clearTimeout(timer);
  if (!outcome.settled) return {settled:false,pending};
  if (outcome.error) throw outcome.error;
  return {settled:true,value:outcome.value,pending};
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
  const record = {generation,promise:null,messageSent:false};
  const promise = startBackgroundTransportOnce(chromeApi,generation,record).finally(() => {
    if (starting?.promise === promise) starting = null;
  });
  record.promise = promise;
  starting = record;
  return promise;
}
async function startBackgroundTransportOnce(chromeApi, generation, startRecord) {
  if (mutationStopCount > 0 || controlClearRequested)
    return {ok:false,reason:'BACKGROUND_STOP_IN_PROGRESS'};
  if (controlClearFailed)
    return {ok:false,reason:'BACKGROUND_CONTROL_CLEAR_FAILED'};
  if (mutationQuarantinePersistenceFailed)
    return {ok:false,reason:'MUTATION_QUARANTINE_STATE_UNAVAILABLE'};
  await assertNoGlobalQuarantineLock(chromeApi);
  if (!(await awaitBounded(controlStorageLane,START_DRAIN_TIMEOUT_MS)))
    return {ok:false,reason:'BACKGROUND_CONTROL_DRAIN_UNCONFIRMED'};
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
  // Mark the transition immediately before dispatching the offscreen START.
  // A Stop before this point invalidates the generation without needing to
  // wait for a still-pending createDocument operation.
  startRecord.messageSent = true;
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
  const pendingStart = starting?.messageSent === true ? starting.promise : null;
  // Fence mutation and grant admission synchronously, before the first await.
  mutationStopRequested = true;
  controlClearRequested = true;
  mutationStopCount += 1;
  lifecycleGeneration++;
  starting = null;
  approvals.stop();
  updateStatus({state:'stopping',connected:false,error:null});

  try {
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
      const cleanup = await enqueueControlOperationBounded(
        () => clearAllBackgroundControls(chromeApi),
        {allowDuringClear:true},
        startDrainTimeoutMs
      );
      if (!cleanup.settled) {
        controlClearFailed = true;
        cleanupError = Error('BACKGROUND_CONTROL_CLEAR_UNCONFIRMED');
        // The queued clear may complete later, but the durable global lock
        // remains and no automatic continuation may reopen this session.
        void cleanup.pending.catch(()=>{});
      } else {
        controlClearFailed = false;
      }
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
      !mutationDrain.drained || !stopConfirmed || Boolean(cleanupError);
    if (!stopConfirmed || !startDrained || !mutationDrain.drained || cleanupError || !intentPersisted) {
      const code = !stopConfirmed || !startDrained || !mutationDrain.drained || !intentPersisted
        ? 'BACKGROUND_STOP_UNCONFIRMED' : 'BACKGROUND_CONTROL_CLEAR_FAILED';
      // Any uncertain global Stop/clear outcome blocks a future Start until
      // an operator-controlled recovery/reconciliation clears this durable lock.
      await persistGlobalQuarantineLock(chromeApi);
      updateStatus({state:'unknown',connected:false,error:code});
      const error = Error(code);
      error.outcome = unknown ? 'UNKNOWN' : 'NOT_PERFORMED';
      if (mutationDrain.tabIds.length) error.quarantinedTabs = mutationDrain.tabIds;
      throw error;
    }

    updateStatus({state:'disconnected',connected:false,error:null});
    return {ok:true,quarantinedTabs:[]};
  } finally {
    mutationStopCount = Math.max(0,mutationStopCount - 1);
    if (mutationStopCount===0) controlClearRequested=false;
  }
}
export function installBackgroundCoordinator(chromeApi, options={}) {
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
        const name=msg.command?.name;
        // Session authorization changes are global control operations: fence
        // mutations synchronously before any storage/browser await.
        const sessionControlChange = name==='session_authorize' || name==='session_revoke';
        if (sessionControlChange) controlClearRequested = true;

        try {
          const {bridgeBackgroundMode,bridgeMutationLabMode,bridgeConnectionDesired} =
            await chromeApi.storage.local.get([
              'bridgeBackgroundMode','bridgeMutationLabMode','bridgeConnectionDesired'
            ]);
          if (bridgeBackgroundMode!==true || bridgeConnectionDesired!==true)
            throw coordinatorError('BACKGROUND_TRANSPORT_DISABLED','BLOCKED');

          const sessionAuthorization=new SessionAuthorization(chromeApi);
          if (name==='session_authorize') {
            try {
              const drained = await drainMutationLanes(chromeApi);
              if (!drained.drained) {
                const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
                error.quarantinedTabs=drained.tabIds;
                throw error;
              }
              const lease=await enqueueControlOperation(async()=>{
                if (mutationStopRequested || mutationStopCount>0)
                  throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
                if (controlClearFailed)
                  throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
                const latest=await chromeApi.storage.local.get([
                  'bridgeBackgroundMode','bridgeConnectionDesired'
                ]);
                if (latest.bridgeBackgroundMode!==true || latest.bridgeConnectionDesired!==true)
                  throw coordinatorError('BACKGROUND_TRANSPORT_DISABLED','BLOCKED');
                if (currentStatus().connected!==true)
                  throw coordinatorError('BRIDGE_NOT_CONNECTED','BLOCKED');
                // A new session starts only after old per-tab grants are gone.
                try {
                  await new BackgroundControlGrants(chromeApi).clear();
                } catch {
                  // A failed grant clear leaves the legacy tab-grant path
                  // potentially live. Keep all mutations blocked until an
                  // explicit cleanup/reconciliation succeeds.
                  controlClearFailed=true;
                  await chromeApi.storage.local.set({bridgeMutationLabMode:false}).catch(()=>{});
                  await persistGlobalQuarantineLock(chromeApi);
                  throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED','UNKNOWN');
                }
                const created=await sessionAuthorization.authorize({
                  ...msg.command.args,bridgeEpoch:msg.command.bridgeEpoch
                });
                try {
                  await chromeApi.storage.local.set({bridgeMutationLabMode:true});
                } catch {
                  // The lease may have been persisted while the feature flag
                  // was not. Revoke it and leave a lock if cleanup is uncertain.
                  try {
                    await sessionAuthorization.revoke();
                    await chromeApi.storage.local.set({bridgeMutationLabMode:false});
                  } catch {
                    controlClearFailed=true;
                    await persistGlobalQuarantineLock(chromeApi);
                    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED','UNKNOWN');
                  }
                  throw coordinatorError('SESSION_AUTH_ENABLE_FAILED','NOT_PERFORMED');
                }
                return created;
              },{allowDuringClear:true});
              controlClearFailed=false;
              return lease;
            } finally {
              if (!mutationStopRequested && mutationStopCount===0)
                controlClearRequested=false;
            }
          }
          if (name==='session_revoke') {
            let cleanupError=null;
            const drained=await drainMutationLanes(chromeApi);
            try {
              const cleanup=await enqueueControlOperationBounded(
                () => clearAllBackgroundControls(chromeApi),
                {allowDuringClear:true}
              );
              if (!cleanup.settled) {
                controlClearFailed=true;
                cleanupError=Error('BACKGROUND_CONTROL_CLEAR_UNCONFIRMED');
                void cleanup.pending.catch(()=>{});
              } else {
                controlClearFailed=false;
              }
            } catch (error) {
              controlClearFailed=true;
              cleanupError=error;
            } finally {
              if (!mutationStopRequested && mutationStopCount===0)
                controlClearRequested=false;
            }
            if (!drained.drained) {
              const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
              error.quarantinedTabs=drained.tabIds;
              throw error;
            }
            if (cleanupError) {
              await persistGlobalQuarantineLock(chromeApi);
              throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED','UNKNOWN');
            }
            return {revoked:true};
          }
          if (name==='session_status') return sessionAuthorization.status(msg.command.bridgeEpoch);
          if (MUTATION_COMMANDS.has(name)) {
            if (bridgeMutationLabMode!==true)
              throw coordinatorError('BACKGROUND_MUTATIONS_DISABLED','BLOCKED');
            await assertMutationAllowed(chromeApi,msg.command?.args?.tabId);
            const grants=new BackgroundControlGrants(chromeApi);
            return dispatchMutation(msg.command,chromeApi,{
              approvals,
              sessionAuthorization,
              controlGrant:(origin,tabId)=>grants.require(origin,tabId),
              stillEnabled:async()=>{
                if (mutationStopRequested || mutationStopCount>0 ||
                    controlClearRequested || controlClearFailed ||
                    mutationQuarantinePersistenceFailed) return false;
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
        } finally {
          if (sessionControlChange && !mutationStopRequested && mutationStopCount===0)
            controlClearRequested=false;
        }
      };
      const replyDispatchError = error => respond({
        error:error?.message || 'COORDINATOR_DISPATCH_FAILED',
        dispatchState:['BLOCKED','NOT_PERFORMED'].includes(error?.dispatchState)
          ? error.dispatchState : 'UNKNOWN',
        sideEffect:typeof error?.sideEffect==='string' ? error.sideEffect : undefined,
        failure:normalizeFailure(error?.failure,{
          stage:'PRECHECK',
          code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message||'')
            ? error.message : 'COORDINATOR_DISPATCH_FAILED',
          startedAt:Date.now()
        })
      });

      if (MUTATION_COMMANDS.has(msg.command?.name)) {
        const tabId=msg.command?.args?.tabId;
        let accepted;
        try {
          accepted=enqueueTabMutation(tabId,async()=>{
            await assertMutationAllowed(chromeApi,tabId);
            return run();
          });
        } catch (error) {
          replyDispatchError(error);
          return false;
        }
        void accepted.then(result=>respond({result}),replyDispatchError);
        return true;
      }
      void run().then(result=>respond({result}),replyDispatchError);
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
      // Revoke-all is a global mutation fence. No accepted page action may
      // continue after the UI receives a successful clear response.
      controlClearRequested = true;
      void (async()=>{
        let cleanupError=null;
        const drained=await drainMutationLanes(chromeApi);
        try {
          const cleanup=await enqueueControlOperationBounded(
            () => clearAllBackgroundControls(chromeApi),
            {allowDuringClear:true}
          );
          if (!cleanup.settled) {
            controlClearFailed=true;
            cleanupError=Error('BACKGROUND_CONTROL_CLEAR_UNCONFIRMED');
            void cleanup.pending.catch(()=>{});
          } else {
            controlClearFailed=false;
          }
        } catch(error) {
          controlClearFailed=true;
          cleanupError=error;
        } finally {
          if (!mutationStopRequested && mutationStopCount===0)
            controlClearRequested=false;
        }
        if (!drained.drained) {
          const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
          error.quarantinedTabs=drained.tabIds;
          throw error;
        }
        if (cleanupError) {
          await persistGlobalQuarantineLock(chromeApi);
          throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED','UNKNOWN');
        }
        return {ok:true};
      })().then(respond,error=>respond({
        error:error.message,
        outcome:error.outcome || (error.dispatchState==='UNKNOWN'?'UNKNOWN':'NOT_PERFORMED'),
        quarantinedTabs:Array.isArray(error.quarantinedTabs)?error.quarantinedTabs:[]
      }));
      return true;
    }
    if (msg.type === 'grant-background-control' || msg.type === 'revoke-background-control') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      if (!Number.isSafeInteger(msg.tabId) || msg.tabId<=0) {
        respond({error:'INVALID_TAB_ID'}); return false;
      }

      if (msg.type==='revoke-background-control') {
        const tabId=msg.tabId;
        // Fence this tab synchronously, then persist the fence before the first
        // drain await. A replacement MV3 worker must not reopen the tab while
        // the accepted mutation or grant-store revoke is still unresolved.
        mutationFencedTabs.set(tabId,(mutationFencedTabs.get(tabId)||0)+1);
        const revoke=async()=>{
          let revokeWriteStarted=false;
          let fenceStore=null;
          let keepFence=false;
          let fenceCleared=false;
          const unknownRevoke=async()=>{
            keepFence=true;
            const persisted=await persistMutationQuarantine(chromeApi,[tabId]);
            const error=coordinatorError('BACKGROUND_REVOKE_UNCONFIRMED','UNKNOWN');
            error.quarantinedTabs=[tabId];
            error.quarantinePersisted=persisted.persisted;
            return error;
          };
          try {
            const fence=await persistTabRevocationFence(chromeApi,tabId);
            if (!fence.persisted) throw await unknownRevoke();
            fenceStore=fence.store;

            const pending=mutationLanes.get(tabId);
            const settled=await awaitBounded(pending,STOP_DRAIN_TIMEOUT_MS);
            if (!settled) throw await unknownRevoke();

            const {origin}=await permittedTab(chromeApi,tabId);
            const sessionStatus=await new SessionAuthorization(chromeApi).status();
            if (sessionStatus.active && sessionStatus.origins.includes(origin))
              throw coordinatorError('SESSION_WIDE_REVOCATION_REQUIRED','BLOCKED');

            revokeWriteStarted=true;
            const revokeWrite=await enqueueControlOperationBounded(
              () => new BackgroundControlGrants(chromeApi).revoke(tabId),
              {tabId,allowFencedTab:true}
            );
            if (!revokeWrite.settled) throw await unknownRevoke();

            if (!await clearTabRevocationFence(chromeApi,tabId,fenceStore))
              throw await unknownRevoke();
            fenceCleared=true;
            return {ok:true,tabId};
          } catch (error) {
            // A precondition denial is safe to return only after removing the
            // durable admission fence. Failed/ambiguous revoke writes retain a
            // permanent quarantine rather than reopening the tab.
            if (!keepFence && fenceStore && !fenceCleared) {
              try {
                fenceCleared=await clearTabRevocationFence(chromeApi,tabId,fenceStore);
              } catch { fenceCleared=false; }
              if (!fenceCleared) throw await unknownRevoke();
            }
            if (!revokeWriteStarted && !keepFence) throw error;
            if (keepFence) throw error;
            throw await unknownRevoke();
          } finally {
            const remaining=(mutationFencedTabs.get(tabId)||1)-1;
            if (remaining>0) mutationFencedTabs.set(tabId,remaining);
            else mutationFencedTabs.delete(tabId);
          }
        };
        void revoke().then(respond,error=>respond({
          error:error.message,
          outcome:error.outcome || (error.dispatchState==='UNKNOWN'?'UNKNOWN':'NOT_PERFORMED'),
          quarantinedTabs:Array.isArray(error.quarantinedTabs)?error.quarantinedTabs:[]
        }));
        return true;
      }

      let accepted;
      try {
        accepted=enqueueControlOperation(async()=>{
          const {bridgeMutationLabMode,bridgeConnectionDesired}=await chromeApi.storage.local.get(
            ['bridgeMutationLabMode','bridgeConnectionDesired']
          );
          if (mutationStopRequested || controlClearRequested ||
              bridgeMutationLabMode!==true || bridgeConnectionDesired!==true)
            throw coordinatorError('BACKGROUND_CONTROL_DISABLED','BLOCKED');
          return new BackgroundControlGrants(chromeApi).grant({
            tabId:msg.tabId,durationMinutes:msg.durationMinutes,localGesture:msg.localGesture===true
          });
        },{tabId:msg.tabId});
      } catch(error) {
        respond({error:error.message});
        return false;
      }
      void accepted.then(respond,error=>respond({error:error.message}));
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
      void stopBackgroundTransport(chromeApi,options).then(respond,e=>respond({ok:false,reason:e.message,outcome:e.outcome || 'UNKNOWN',quarantinedTabs:Array.isArray(e.quarantinedTabs)?e.quarantinedTabs:[]}));
      return true;
    }
    return false;
  });
}
