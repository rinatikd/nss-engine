import { dispatchReadOnly, permittedTab } from './read-only-dispatch.js';
import { ApprovalSession } from './approval-session.js';
import { dispatchMutation, cancelMutationOperation } from './mutation-dispatch.js';
import { BackgroundControlGrants } from './background-control-grants.js';
import { SessionAuthorization } from './session-authorization.js';
import { normalizeFailure } from './failure-contract.js';
import { MutationOperationJournal } from './mutation-operation-journal.js';

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
const mutationContexts = new Map();
const mutationFencedTabs = new Map();
const mutationQuarantinedTabs = new Set();
let mutationStopRequested = false;
let mutationStopCount = 0;
let mutationQuarantinePersistenceFailed = false;
let controlStorageLane = Promise.resolve();
let revocationFenceLane = Promise.resolve();
let controlClearRequested = false;
let controlClearFailed = false;
const mutationOperationJournals = new WeakMap();
const mutationOperationRecovery = new WeakMap();

function mutationOperationJournalFor(chromeApi) {
  let journal=mutationOperationJournals.get(chromeApi);
  if (!journal) {
    journal=new MutationOperationJournal(chromeApi);
    mutationOperationJournals.set(chromeApi,journal);
  }
  return journal;
}
function ensureMutationOperationRecovery(chromeApi) {
  let recovery=mutationOperationRecovery.get(chromeApi);
  if (!recovery) {
    const journal=mutationOperationJournalFor(chromeApi);
    recovery=journal.recover().then(async result=>{
      if (result.corrupt) {
        mutationQuarantinePersistenceFailed=true;
        await persistGlobalQuarantineLock(chromeApi);
        throw Error('MUTATION_OPERATION_JOURNAL_CORRUPT');
      }
      // UNKNOWN journal rows remain immutable evidence after operator
      // reconciliation. Do not recreate their quarantine on every later MV3
      // restart once the same operation has a durable, exact-document audit.
      // A missing/malformed audit never counts as reconciliation: it leaves
      // the row unresolved and therefore quarantined.
      const quarantineState=await readQuarantineSnapshot(chromeApi);
      const audited=quarantineState.audits.filter(event=>
        event?.type==='OPERATOR_RECONCILE' &&
        event.trustBoundary==='LOCAL_MACHINE_TRUSTED_CONTROL_UI' &&
        typeof event.operationId==='string' &&
        typeof event.requestId==='string' &&
        event.confirmed===true && event.localGesture===true &&
        event.backgroundGrantRevokedAndVerified===true &&
        event.sessionAuthorizationAbsent===true &&
        event.evidence && typeof event.evidence==='object' &&
        typeof event.evidence.documentId==='string' &&
        event.evidence.frameId===0 &&
        Number.isFinite(event.reconciledAt)
      );
      const isAudited=operation=>audited.some(event=>
        event.operationId===operation.operationId &&
        event.requestId===operation.requestId &&
        event.command===operation.command &&
        event.origin===operation.origin &&
        event.conversationId===operation.conversationId &&
        event.evidence.documentId===operation.documentId &&
        event.evidence.frameId===operation.frameId
      );
      const unresolved=(result.unresolved||[]).filter(operation=>!isAudited(operation));
      const quarantinedTabs=[...new Set(unresolved.map(operation=>operation.tabId))];
      const recovered={...result,unresolved,quarantinedTabs};
      if (quarantinedTabs.length) {
        const persisted=await persistMutationQuarantine(
          chromeApi,quarantinedTabs,unresolved
        );
        if (!persisted.persisted) {
          await persistGlobalQuarantineLock(chromeApi);
          throw Error('MUTATION_QUARANTINE_STATE_UNAVAILABLE');
        }
      }
      return recovered;
    }).catch(async error=>{
      mutationQuarantinePersistenceFailed=true;
      await persistGlobalQuarantineLock(chromeApi);
      throw Error(error?.message==='MUTATION_OPERATION_JOURNAL_CORRUPT'
        ? 'MUTATION_OPERATION_JOURNAL_CORRUPT'
        : 'MUTATION_OPERATION_JOURNAL_UNAVAILABLE');
    });
    mutationOperationRecovery.set(chromeApi,recovery);
  }
  return recovery;
}

function coordinatorError(code, dispatchState='NOT_PERFORMED') {
  return Object.assign(Error(code), {dispatchState});
}

// Grants, Revoke and global clear all mutate the same session-storage object.
// One FIFO prevents stale read/modify/write snapshots from overwriting each other.
function enqueueRevocationFence(task) {
  const next = revocationFenceLane.catch(() => {}).then(task);
  revocationFenceLane = next;
  void next.catch(() => {});
  return next;
}

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
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS','BLOCKED');

  const next = controlStorageLane.catch(() => {}).then(() => {
    if (!allowFencedTab && tabId !== null && mutationFencedTabs.has(tabId))
      throw coordinatorError('TAB_CONTROL_REVOKING');
    if (!allowDuringClear && mutationStopRequested)
      throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
    if (!allowDuringClear && controlClearFailed)
      throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
    if (!allowDuringClear && controlClearRequested)
      throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS','BLOCKED');
    return task();
  });
  controlStorageLane = next;
  void next.catch(() => {});
  return next;
}

function enqueueTabMutation(tabId, task, context=null) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0)
    throw coordinatorError('INVALID_MUTATION_TAB');
  if (mutationStopRequested)
    throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
  if (controlClearFailed)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
  if (controlClearRequested)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS','BLOCKED');
  if (mutationQuarantinePersistenceFailed)
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE');
  if (mutationFencedTabs.has(tabId))
    throw coordinatorError('TAB_MUTATION_REVOKING');
  if (mutationQuarantinedTabs.has(tabId))
    throw coordinatorError('TAB_MUTATION_QUARANTINED');

  const previous = mutationLanes.get(tabId) || Promise.resolve();
  // Keep the currently executing operation, not merely the last accepted
  // queued command. A later task must not overwrite the identity of an
  // earlier in-flight page action that Global Revoke may need to quarantine.
  const contextRecord=context ? {...context,acceptedAt:Date.now(),startedAt:null} : null;
  let contextActivated=false;
  const activateContext=()=>{
    if (!contextRecord || contextActivated) return;
    contextActivated=true;
    contextRecord.startedAt=Date.now();
    mutationContexts.set(tabId,contextRecord);
  };
  const next = previous.catch(() => {}).then(() => {
    if (mutationStopRequested)
      throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
    if (controlClearFailed)
      throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
    if (controlClearRequested)
      throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS','BLOCKED');
    if (mutationQuarantinePersistenceFailed)
      throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE');
    if (mutationFencedTabs.has(tabId))
      throw coordinatorError('TAB_MUTATION_REVOKING');
    if (mutationQuarantinedTabs.has(tabId))
      throw coordinatorError('TAB_MUTATION_QUARANTINED');
    return task(activateContext);
  });
  mutationLanes.set(tabId, next);
  void next.finally(() => {
    if (mutationLanes.get(tabId) === next) mutationLanes.delete(tabId);
    if (contextRecord && mutationContexts.get(tabId)===contextRecord)
      mutationContexts.delete(tabId);
  }).catch(() => {});
  return next;
}

async function assertMutationAllowed(chromeApi, tabId) {
  if (mutationStopRequested)
    throw coordinatorError('BACKGROUND_STOP_IN_PROGRESS');
  if (controlClearFailed)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED');
  if (controlClearRequested)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS','BLOCKED');
  if (mutationQuarantinePersistenceFailed)
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE');
  if (mutationFencedTabs.has(tabId))
    throw coordinatorError('TAB_MUTATION_REVOKING');
  if (mutationQuarantinedTabs.has(tabId))
    throw coordinatorError('TAB_MUTATION_QUARANTINED');

  const local = await chromeApi.storage.local.get([
    'bridgeMutationQuarantinedTabs','bridgeMutationQuarantineRecords',
    'bridgeMutationQuarantineLock','bridgeMutationRevokingTabs',
    'bridgeMutationRevocationPending'
  ]);
  let session = {};
  if (chromeApi.storage.session?.get) {
    session = await chromeApi.storage.session.get([
      'bridgeMutationQuarantinedTabs','bridgeMutationQuarantineRecords',
      'bridgeMutationQuarantineLock','bridgeMutationRevokingTabs',
      'bridgeMutationRevocationPending'
    ]);
  }
  // Recheck after Storage awaits: Revoke may have installed its in-memory
  // admission fence while this mutation was reading durable state.
  if (mutationFencedTabs.has(tabId))
    throw coordinatorError('TAB_MUTATION_REVOKING');
  if (mutationQuarantinedTabs.has(tabId))
    throw coordinatorError('TAB_MUTATION_QUARANTINED');
  if (local.bridgeMutationQuarantineLock === true ||
      session.bridgeMutationQuarantineLock === true)
    throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE');
  if (local.bridgeMutationRevocationPending?.pending === true ||
      session.bridgeMutationRevocationPending?.pending === true)
    throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS','BLOCKED');

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
  const recordIds=state=>{
    const records=state.bridgeMutationQuarantineRecords;
    if (records===undefined || records===null) return [];
    if (typeof records!=='object' || Array.isArray(records))
      throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','BLOCKED');
    const ids=[];
    for (const [key,record] of Object.entries(records)) {
      const id=Number(key);
      if (!Number.isSafeInteger(id) || id<=0 || !record || typeof record!=='object' ||
          record.tabId!==id || typeof record.token!=='string' || !record.token)
        throw coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','BLOCKED');
      ids.push(id);
    }
    return ids;
  };
  const localRecordIds=recordIds(local),sessionRecordIds=recordIds(session);
  for (const id of [...localTabs,...sessionTabs,...localRecordIds,...sessionRecordIds]) {
    if (Number.isSafeInteger(id) && id > 0) mutationQuarantinedTabs.add(id);
  }
  if (mutationQuarantinedTabs.has(tabId) ||
      localTabs.includes(tabId) || sessionTabs.includes(tabId) ||
      localRecordIds.includes(tabId) || sessionRecordIds.includes(tabId))
    throw coordinatorError('TAB_MUTATION_QUARANTINED');
}

async function enrichGlobalRevocationFenceFromRecoveredOperations(chromeApi,recoveredByTab) {
  let snapshot;
  try {
    snapshot=await readGlobalRevocationFence(chromeApi);
  } catch {
    // The global fence remains untouched. The per-tab quarantine is still
    // independently persisted with its complete journal identity below.
    return false;
  }
  const record=snapshot.record;
  if (!record) return true;
  const affected=new Set(Array.isArray(record.affectedTabs)?record.affectedTabs:[]);
  const operations=Array.isArray(record.operations)?record.operations.slice():[];
  let changed=false;

  for (const [rawTabId,rows] of recoveredByTab.entries()) {
    const tabId=Number(rawTabId);
    if (!affected.has(tabId) || rows.length!==1) continue;
    const item=rows[0];
    if (typeof item?.operationId!=='string' || !item.operationId ||
        typeof item.requestId!=='string' || !item.requestId ||
        typeof item.documentId!=='string' || !item.documentId ||
        item.frameId!==0) continue;

    const index=operations.findIndex(operation=>operation?.tabId===tabId);
    const prior=index>=0?operations[index]:null;
    // Never rewrite a global fence from one operation to another. Fill only
    // missing identity fields on the same request/command; any conflict stays
    // blocked for independent review.
    if (prior && (
      (prior.operationId && prior.operationId!==item.operationId) ||
      (prior.requestId && prior.requestId!==item.requestId) ||
      (prior.command && prior.command!==item.command) ||
      (prior.origin && prior.origin!==item.origin) ||
      (prior.conversationId && prior.conversationId!==item.conversationId) ||
      (prior.documentId && prior.documentId!==item.documentId) ||
      (Number.isSafeInteger(prior.frameId) && prior.frameId!==item.frameId) ||
      (prior.operationId && Number.isFinite(prior.startedAt) &&
        prior.startedAt!==item.startedAt)
    )) continue;

    const merged={
      ...(prior||{}),tabId,operationId:item.operationId,
      requestId:item.requestId,command:item.command,
      taskId:item.taskId||null,providerId:item.providerId||null,
      origin:item.origin||null,conversationId:item.conversationId||null,
      documentId:item.documentId,frameId:item.frameId,
      epoch:Number.isSafeInteger(item.epoch)?item.epoch:null,
      payloadHash:item.payloadHash||null,preparedId:item.preparedId||null,
      startedAt:Number.isFinite(item.startedAt)?item.startedAt:null
    };
    if (prior) operations[index]=merged;
    else operations.push(merged);
    if (!prior || JSON.stringify(prior)!==JSON.stringify(merged)) changed=true;
  }

  if (!changed) return true;
  operations.sort((a,b)=>a.tabId-b.tabId);
  const updated={...record,operations};
  const key='bridgeMutationRevocationPending';
  const written=[];
  try {
    for (const store of snapshot.stores) {
      const storage=store==='local'?chromeApi.storage.local:
        store==='session'?chromeApi.storage.session:null;
      if (!storage?.get || !storage?.set)
        throw Error('GLOBAL_REVOCATION_FENCE_STORE_UNAVAILABLE');
      const current=await storage.get(key);
      if (current[key]?.token!==record.token)
        throw Error('GLOBAL_REVOCATION_FENCE_TOKEN_CHANGED');
      await storage.set({[key]:updated});
      written.push(store);
    }
    const verified=await readGlobalRevocationFence(chromeApi);
    if (!verified.record || verified.record.token!==record.token ||
        JSON.stringify(verified.record.operations)!==JSON.stringify(updated.operations))
      throw Error('GLOBAL_REVOCATION_FENCE_ENRICHMENT_UNCONFIRMED');
    return true;
  } catch {
    let restored=true;
    for (const store of written) {
      try {
        const storage=store==='local'?chromeApi.storage.local:chromeApi.storage.session;
        const current=await storage.get(key);
        if (current[key]?.token===record.token)
          await storage.set({[key]:record});
        else restored=false;
      } catch { restored=false; }
    }
    if (!restored) {
      mutationQuarantinePersistenceFailed=true;
      try { await persistGlobalQuarantineLock(chromeApi); } catch { /* fail closed in memory */ }
    }
    return false;
  }
}

async function persistMutationQuarantine(chromeApi, tabIds, recoveredOperations=[]) {
  const now=Date.now();
  let journalRecords;
  try {
    // list() verifies the global journal index and every immutable operation
    // record. A read/verification failure is not evidence that an operation
    // was safe; keep the global lock fail-closed instead.
    journalRecords=await mutationOperationJournalFor(chromeApi).list();
  } catch {
    mutationQuarantinePersistenceFailed=true;
    return {persisted:false,store:null,quarantinedTabs:[]};
  }

  const isUnresolved=record=>{
    const terminal=record.events.at(-1);
    return terminal.phase==='INJECTING' || terminal.phase==='UNKNOWN' ||
      (terminal.phase==='COMPLETED' &&
        terminal.sideEffect==='composer-draft-state-unverified') ||
      (terminal.phase==='COMPLETED' &&
        ['browser_click','browser_fill'].includes(record.command) &&
        terminal.sideEffect==='generic-page-action');
  };

  // A prior-worker Global Revoke snapshot may contain only the volatile
  // coordinator context. Resolve it against the verified WAL before deciding
  // whether a tab needs quarantine. ACCEPTED/ABORTED_BEFORE_INJECTION and
  // other proven terminal records do not represent an outstanding page side
  // effect; an absent WAL record also proves no page action could have started,
  // because the WAL begin is mandatory before injection.
  for (const item of Array.isArray(recoveredOperations)?recoveredOperations:[]) {
    if (!item || !Number.isSafeInteger(item.tabId) || item.tabId<=0) continue;
    const matching=journalRecords.filter(record=>
      record.tabId===item.tabId &&
      ((typeof item.operationId==='string' && record.operationId===item.operationId) ||
       (!item.operationId && typeof item.requestId==='string' &&
        record.requestId===item.requestId && record.command===item.command)));
    if (matching.length>1) {
      mutationQuarantinePersistenceFailed=true;
      return {persisted:false,store:null,quarantinedTabs:[]};
    }
    const row=matching[0];
    if (row && (
      (item.requestId && row.requestId!==item.requestId) ||
      (item.command && row.command!==item.command) ||
      (item.origin && row.origin!==item.origin) ||
      (item.conversationId && row.conversationId!==item.conversationId) ||
      (item.operationId && row.operationId!==item.operationId)
    )) {
      mutationQuarantinePersistenceFailed=true;
      return {persisted:false,store:null,quarantinedTabs:[]};
    }
  }

  const unresolvedRecords=journalRecords.filter(record=>
    tabIds.includes(record.tabId) && isUnresolved(record)
  );
  const recoveredByTab=new Map();
  for (const record of unresolvedRecords) {
    const injecting=record.events.find(event=>event.phase==='INJECTING') || null;
    const terminal=record.events.at(-1);
    const item={
      operationId:record.operationId,command:record.command,tabId:record.tabId,
      origin:record.origin,urlSha256:record.urlSha256,
      documentId:record.documentId,frameId:record.frameId,
      conversationId:record.conversationId,requestId:record.requestId,
      taskId:record.taskId,providerId:record.providerId,
      preparedId:record.preparedId,payloadHash:record.payloadHash,epoch:record.epoch,
      startedAt:injecting?.at ?? null,
      reasonCode:terminal.code || (terminal.phase==='INJECTING'
        ? 'MUTATION_OPERATION_INJECTING'
        : terminal.phase==='UNKNOWN'?'MUTATION_OPERATION_UNKNOWN'
          :'MUTATION_SIDE_EFFECT_UNVERIFIED')
    };
    const rows=recoveredByTab.get(record.tabId)||[];
    rows.push(item);
    recoveredByTab.set(record.tabId,rows);
  }

  const quarantinedTabs=[...recoveredByTab.keys()];
  if (!quarantinedTabs.length)
    return {persisted:true,store:null,quarantinedTabs:[]};

  // Only unresolved, verified WAL operations are quarantined. A single
  // tab-level record cannot safely represent multiple unresolved operations.
  for (const tabId of quarantinedTabs) mutationQuarantinedTabs.add(tabId);
  await enrichGlobalRevocationFenceFromRecoveredOperations(chromeApi,recoveredByTab);

  const records={};
  for (const tabId of quarantinedTabs) {
    const rows=recoveredByTab.get(tabId)||[];
    const context=rows.length===1?rows[0]:null;
    const multipleUnresolved=rows.length>1;
    records[String(tabId)]={
      schemaVersion:1,tabId,token:crypto.randomUUID(),
      operationId:context?.operationId || null,
      requestId:context?.requestId || null,
      command:context?.command || null,
      taskId:context?.taskId || null,
      providerId:context?.providerId || null,
      origin:context?.origin || null,
      conversationId:context?.conversationId || null,
      documentId:typeof context?.documentId==='string'?context.documentId:null,
      frameId:Number.isSafeInteger(context?.frameId)?context.frameId:null,
      epoch:Number.isSafeInteger(context?.epoch)?context.epoch:null,
      payloadHash:context?.payloadHash || null,
      preparedId:context?.preparedId || null,
      startedAt:Number.isFinite(context?.startedAt)?context.startedAt:now,
      quarantinedAt:now,
      reasonCode:multipleUnresolved?'MULTIPLE_UNRESOLVED_OPERATIONS':
        context?.reasonCode || 'BACKGROUND_STOP_UNCONFIRMED',
      reconcilable:Boolean(context?.operationId && context?.requestId &&
        ['provider_prepare','provider_commit'].includes(context?.command) &&
        typeof context?.origin==='string' &&
        typeof context?.conversationId==='string' &&
        typeof context?.documentId==='string' && context.documentId &&
        context.frameId===0 && Number.isFinite(context?.startedAt) &&
        !multipleUnresolved)
    };
  }
  const writeTo=async(storage,store)=>{
    const state=await storage.get(['bridgeMutationQuarantinedTabs','bridgeMutationQuarantineRecords']);
    const prior=Array.isArray(state.bridgeMutationQuarantinedTabs)
      ? state.bridgeMutationQuarantinedTabs : [];
    const priorRecords=state.bridgeMutationQuarantineRecords &&
      typeof state.bridgeMutationQuarantineRecords==='object'
      ? state.bridgeMutationQuarantineRecords : {};
    const nextRecords={...priorRecords};
    for (const [id,record] of Object.entries(records)) {
      // Never replace an existing quarantine token with a newer operation.
      if (!nextRecords[id]) nextRecords[id]=record;
    }
    await storage.set({
      bridgeMutationQuarantinedTabs:[...new Set([...prior,...quarantinedTabs])],
      bridgeMutationQuarantineRecords:nextRecords
    });
    return {persisted:true,store,quarantinedTabs};
  };
  try {
    return await writeTo(chromeApi.storage.local,'local');
  } catch {
    // chrome.storage.session survives an MV3 service-worker restart; local is
    // preferred because its quarantine survives a browser restart as well.
    try {
      return await writeTo(chromeApi.storage.session,'session');
    } catch {
      mutationQuarantinePersistenceFailed = true;
      try {
        await chromeApi.storage.local.set({bridgeMutationQuarantineLock:true});
      } catch {
        try {
          await chromeApi.storage.session.set({bridgeMutationQuarantineLock:true});
        } catch { /* no durable storage path remains */ }
      }
      return {persisted:false,store:null,quarantinedTabs};
    }
  }
}

// A Revoke fence must survive MV3 worker suspension while the accepted tab
// lane drains. The marker is removed only after the grant-store revoke is
// confirmed; a restarted worker therefore rejects new page actions.
async function quarantineUnreconciledGenericActions(chromeApi,scopeTabIds=null) {
  let records;
  try {
    records=await mutationOperationJournalFor(chromeApi).list();
  } catch {
    await persistGlobalQuarantineLock(chromeApi);
    throw coordinatorError('MUTATION_OPERATION_JOURNAL_UNAVAILABLE','UNKNOWN');
  }
  const scope=Array.isArray(scopeTabIds)?new Set(scopeTabIds):null;
  const affected=[...new Set(records.filter(record=>{
    if (!['browser_click','browser_fill'].includes(record.command)) return false;
    if (scope && !scope.has(record.tabId)) return false;
    const terminal=record.events.at(-1);
    return terminal.phase==='INJECTING' || terminal.phase==='UNKNOWN' ||
      (terminal.phase==='COMPLETED' && terminal.sideEffect==='generic-page-action');
  }).map(record=>record.tabId))];
  if (!affected.length) return [];
  const persisted=await persistMutationQuarantine(chromeApi,affected);
  if (!persisted.persisted) {
    await persistGlobalQuarantineLock(chromeApi);
    const error=coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','UNKNOWN');
    error.quarantinedTabs=affected;
    throw error;
  }
  return affected;
}

async function cancelActiveMutationOperations(chromeApi,scopeTabIds=null) {
  let records;
  try {
    records=await mutationOperationJournalFor(chromeApi).list();
  } catch {
    await persistGlobalQuarantineLock(chromeApi);
    throw coordinatorError('MUTATION_OPERATION_JOURNAL_UNAVAILABLE','UNKNOWN');
  }
  const scope=Array.isArray(scopeTabIds)?new Set(scopeTabIds):null;
  const pending=records.filter(record=>{
    if (scope && !scope.has(record.tabId)) return false;
    return record.events.at(-1)?.phase==='INJECTING';
  });
  const results=[];
  for (const record of pending) {
    const result=await cancelMutationOperation(chromeApi,record,{timeoutMs:1800});
    results.push({
      operationId:record.operationId,tabId:record.tabId,
      safeToRelease:result?.safeToRelease===true,
      reason:typeof result?.reason==='string'?result.reason:
        result?.state||'CANCELLATION_NOT_CONFIRMED'
    });
  }
  return results;
}

async function persistTabRevocationFence(chromeApi, tabId) {
  const key = 'bridgeMutationRevokingTabs';
  try {
    // Read both stores so a stale marker from an earlier fallback cannot be
    // overlooked and left behind after a later successful Revoke.
    const [localState,sessionState] = await Promise.all([
      chromeApi.storage.local.get(key),
      chromeApi.storage.session.get(key)
    ]);
    const localPrior = Array.isArray(localState[key]) ? localState[key] : [];
    const sessionPrior = Array.isArray(sessionState[key]) ? sessionState[key] : [];
    const next = [...new Set([...localPrior,...sessionPrior,tabId])];
    // Keep both copies: local survives browser restart; session survives an
    // MV3 worker restart even if local storage is temporarily unavailable later.
    let localWritten=false,sessionWritten=false;
    try {
      await chromeApi.storage.local.set({[key]:next});
      localWritten=true;
    } catch { /* session storage may still provide a durable worker fence */ }
    try {
      await chromeApi.storage.session.set({[key]:next});
      sessionWritten=true;
    } catch { /* local storage may still provide a durable browser fence */ }
    if (!localWritten && !sessionWritten) {
      mutationQuarantinePersistenceFailed = true;
      return {persisted:false,stores:[]};
    }
    return {persisted:true,stores:[...(localWritten || localPrior.includes(tabId)?['local']:[]),...(sessionWritten || sessionPrior.includes(tabId)?['session']:[])]};
  } catch {
    mutationQuarantinePersistenceFailed = true;
    return {persisted:false,stores:[]};
  }
}

async function clearTabRevocationFence(chromeApi, tabId, stores) {
  if (!Array.isArray(stores) || !stores.length) return false;
  const key = 'bridgeMutationRevokingTabs';
  for (const store of stores) {
    const storage = store === 'local' ? chromeApi.storage.local :
      store === 'session' ? chromeApi.storage.session : null;
    if (!storage?.get || !storage?.set) return false;
    const state = await storage.get(key);
    const prior = Array.isArray(state[key]) ? state[key] : [];
    await storage.set({[key]:prior.filter(id=>id!==tabId)});
  }
  return true;
}

async function readGlobalRevocationFence(chromeApi) {
  const key='bridgeMutationRevocationPending';
  const [localState,sessionState]=await Promise.all([
    chromeApi.storage.local.get(key),
    chromeApi.storage.session.get(key)
  ]);
  const validate=(value,store)=>{
    if (value===undefined || value===null) return null;
    if (!value || typeof value!=='object' || Array.isArray(value) ||
        value.pending!==true || typeof value.token!=='string' ||
        value.token.length<8 || value.token.length>256 ||
        !Number.isFinite(value.startedAt))
      throw new Error('GLOBAL_REVOCATION_FENCE_INVALID:'+store);
    if (value.affectedTabs!==undefined &&
        (!Array.isArray(value.affectedTabs) ||
         value.affectedTabs.some(id=>!Number.isSafeInteger(id)||id<=0) ||
         new Set(value.affectedTabs).size!==value.affectedTabs.length))
      throw new Error('GLOBAL_REVOCATION_FENCE_SCOPE_INVALID:'+store);
    if (value.operations!==undefined) {
      if (!Array.isArray(value.operations))
        throw new Error('GLOBAL_REVOCATION_FENCE_OPERATIONS_INVALID:'+store);
      const seen=new Set();
      for (const operation of value.operations) {
        if (!operation || typeof operation!=='object' ||
            !Number.isSafeInteger(operation.tabId) || operation.tabId<=0 ||
            !Array.isArray(value.affectedTabs) || !value.affectedTabs.includes(operation.tabId) ||
            seen.has(operation.tabId))
          throw new Error('GLOBAL_REVOCATION_FENCE_OPERATIONS_INVALID:'+store);
        seen.add(operation.tabId);
      }
    }
    return value;
  };
  const localPending=validate(localState[key],'local');
  const sessionPending=validate(sessionState[key],'session');
  const sameSnapshot=(a,b)=>a.token===b.token &&
    a.startedAt===b.startedAt &&
    JSON.stringify(a.affectedTabs??null)===JSON.stringify(b.affectedTabs??null) &&
    JSON.stringify(a.operations??null)===JSON.stringify(b.operations??null);
  if (localPending && sessionPending && !sameSnapshot(localPending,sessionPending))
    throw new Error('GLOBAL_REVOCATION_FENCE_STORE_CONFLICT');
  const record=localPending || sessionPending || null;
  const stores=[
    ...(localPending?['local']:[]),
    ...(sessionPending?['session']:[])
  ];
  return {record,stores};
}

async function persistGlobalRevocationFence(chromeApi, affectedTabs, contextSnapshot=null) {
  const key='bridgeMutationRevocationPending';
  try {
    const current=await readGlobalRevocationFence(chromeApi);
    if (current.record) return {
      persisted:true,existing:true,record:current.record,stores:current.stores
    };
    const tabIds=[...new Set(affectedTabs.filter(id=>Number.isSafeInteger(id)&&id>0))];
    // The page-action write-ahead journal is the authority for operation and
    // document identity. The coordinator context is created earlier, before
    // preflight, and cannot safely supply these fields by itself.
    let journalRows=[];
    try { journalRows=await mutationOperationJournalFor(chromeApi).list(); }
    catch { /* keep the durable fence; absent journal identity will not be reconcilable */ }
    const contexts=contextSnapshot instanceof Map ? contextSnapshot : mutationContexts;
    const operations=tabIds.map(tabId=>{
      const context=contexts.get(tabId);
      if (!context) return null;
      const matching=journalRows.filter(item=>
        item.tabId===tabId && item.requestId===context.requestId &&
        item.command===context.command);
      const journalRecord=matching.length===1?matching[0]:null;
      const injecting=journalRecord?.events?.find(event=>event.phase==='INJECTING') || null;
      return {
        tabId,operationId:journalRecord?.operationId || null,
        requestId:context.requestId || null,command:context.command || null,
        taskId:context.taskId || null,providerId:context.providerId || null,
        origin:context.origin || null,conversationId:context.conversationId || null,
        documentId:injecting?.documentId || journalRecord?.documentId || null,
        frameId:Number.isSafeInteger(injecting?.frameId)
          ? injecting.frameId : journalRecord?.frameId ?? null,
        epoch:Number.isSafeInteger(context.epoch)?context.epoch:null,
        payloadHash:context.payloadHash || null,preparedId:context.preparedId || null,
        startedAt:injecting?.at ?? (Number.isFinite(context.startedAt)?context.startedAt:Date.now())
      };
    }).filter(Boolean);
    const record={
      pending:true,
      token:`${Date.now()}-${Math.random().toString(36).slice(2)}`,
      affectedTabs:tabIds,operations,startedAt:Date.now()
    };
    let localWritten=false,sessionWritten=false;
    try {
      await chromeApi.storage.local.set({[key]:record});
      localWritten=true;
    } catch { /* session storage may still provide a worker-lifetime fence */ }
    try {
      await chromeApi.storage.session.set({[key]:record});
      sessionWritten=true;
    } catch { /* local storage may still provide a browser-lifetime fence */ }
    if (!localWritten && !sessionWritten) {
      mutationQuarantinePersistenceFailed=true;
      return {persisted:false,existing:false,record:null,stores:[]};
    }
    return {persisted:true,existing:false,record,stores:[...(localWritten?['local']:[]),...(sessionWritten?['session']:[])]};
  } catch {
    mutationQuarantinePersistenceFailed=true;
    return {persisted:false,existing:false,record:null,stores:[]};
  }
}

async function clearGlobalRevocationFence(chromeApi, record, stores) {
  if (!record?.token || !Array.isArray(stores) || !stores.length) return false;
  const key='bridgeMutationRevocationPending';
  try {
    for (const store of stores) {
      const storage=store==='local' ? chromeApi.storage.local :
        store==='session' ? chromeApi.storage.session : null;
      if (!storage?.get || !storage?.set) return false;
      const state=await storage.get(key);
      const current=state[key];
      if (current?.pending===true && current.token!==record.token) return false;
      if (current?.token===record.token)
        await storage.set({[key]:null});
    }
    return true;
  } catch {
    return false;
  }
}

async function readQuarantineSnapshot(chromeApi) {
  // Quarantine records and local-machine operator audit are security state.
  // Restrict both stores before every read, including UI-only status/reconcile
  // flows that may run before the normal transport-start path.
  if (!chromeApi.storage.local?.setAccessLevel ||
      !chromeApi.storage.session?.setAccessLevel)
    throw coordinatorError('QUARANTINE_STORAGE_ACCESS_RESTRICTION_UNAVAILABLE','BLOCKED');
  try {
    await Promise.all([
      chromeApi.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
      chromeApi.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})
    ]);
  } catch {
    throw coordinatorError('QUARANTINE_STORAGE_ACCESS_RESTRICTION_UNAVAILABLE','BLOCKED');
  }
  const keys=[
    'bridgeMutationQuarantinedTabs','bridgeMutationQuarantineRecords',
    'bridgeMutationQuarantineAudit','bridgeMutationRevokingTabs',
    'bridgeMutationQuarantineLock'
  ];
  const [local,session]=await Promise.all([
    chromeApi.storage.local.get(keys),
    chromeApi.storage.session.get(keys)
  ]);
  const records={};
  const recordStores={};
  for (const [store,state] of [['local',local],['session',session]]) {
    const storedRecords=state.bridgeMutationQuarantineRecords;
    if (storedRecords!==undefined && storedRecords!==null &&
        (typeof storedRecords!=='object' || Array.isArray(storedRecords)))
      throw coordinatorError('QUARANTINE_RECORDS_UNAVAILABLE','BLOCKED');
    const current=storedRecords || {};
    for (const [rawId,record] of Object.entries(current)) {
      const id=Number(rawId);
      if (!Number.isSafeInteger(id) || id<=0 || String(id)!==rawId ||
          !record || typeof record!=='object' || Array.isArray(record) ||
          record.schemaVersion!==1 || record.tabId!==id ||
          typeof record.token!=='string' || record.token.length<8 || record.token.length>256 ||
          !Number.isFinite(record.startedAt) || !Number.isFinite(record.quarantinedAt) ||
          typeof record.reconcilable!=='boolean')
        throw coordinatorError('QUARANTINE_RECORDS_UNAVAILABLE','BLOCKED');
      if (records[rawId] && JSON.stringify(records[rawId])!==JSON.stringify(record))
        throw coordinatorError('QUARANTINE_RECORD_STORE_CONFLICT','BLOCKED');
      if (!records[rawId]) records[rawId]=record;
      (recordStores[rawId] ||= []).push(store);
    }
  }
  const validateTabList=(value,store,key)=>{
    if (value===undefined || value===null) return [];
    if (!Array.isArray(value) ||
        value.some(id=>!Number.isSafeInteger(id)||id<=0) ||
        new Set(value).size!==value.length)
      throw coordinatorError('QUARANTINE_STORAGE_LIST_INVALID','BLOCKED');
    return value;
  };
  const localTabs=validateTabList(local.bridgeMutationQuarantinedTabs,'local','bridgeMutationQuarantinedTabs');
  const sessionTabs=validateTabList(session.bridgeMutationQuarantinedTabs,'session','bridgeMutationQuarantinedTabs');
  const validateAudit=(value)=>{
    if (value===undefined || value===null) return [];
    if (!Array.isArray(value) || value.some(event=>
      !event || typeof event!=='object' || event.schemaVersion!==1 ||
      event.type!=='OPERATOR_RECONCILE' || typeof event.eventId!=='string' ||
      !Number.isSafeInteger(event.tabId) || event.tabId<=0 ||
      typeof event.quarantineToken!=='string' || typeof event.requestId!=='string' ||
      (event.trustBoundary!==undefined &&
        event.trustBoundary!=='LOCAL_MACHINE_TRUSTED_CONTROL_UI') ||
      !Number.isFinite(event.reconciledAt)))
      throw coordinatorError('QUARANTINE_AUDIT_INVALID','BLOCKED');
    return value;
  };
  const audits=[
    ...validateAudit(local.bridgeMutationQuarantineAudit),
    ...validateAudit(session.bridgeMutationQuarantineAudit)
  ];
  const recordIds=Object.keys(records).map(Number);
  const quarantinedTabs=[...new Set([...localTabs,...sessionTabs,...recordIds])];
  const global=await readGlobalRevocationFence(chromeApi);
  return {
    local,session,records,recordStores,quarantinedTabs,audits,global,
    globalLock:local.bridgeMutationQuarantineLock===true ||
      session.bridgeMutationQuarantineLock===true
  };
}

async function readQuarantineStatus(chromeApi) {
  const state=await readQuarantineSnapshot(chromeApi);
  const records=state.quarantinedTabs.map(tabId=>{
    const record=state.records[String(tabId)];
    return record ? {
      ...record,store:(state.recordStores[String(tabId)]||[]).join('+'),
      reconcilable:record.reconcilable===true &&
        typeof record.operationId==='string' && typeof record.documentId==='string' &&
        record.documentId.length>0 && record.frameId===0
    } : {
      schemaVersion:1,tabId,token:null,reasonCode:'QUARANTINE_RECORD_MISSING',
      reconcilable:false
    };
  });
  return {
    available:true,records,
    quarantinedTabs:state.quarantinedTabs,
    globalPending:state.global.record ? {
      token:state.global.record.token,
      affectedTabs:Array.isArray(state.global.record.affectedTabs)
        ? state.global.record.affectedTabs : [],
      startedAt:state.global.record.startedAt || null
    } : null,
    globalLock:state.globalLock
  };
}

async function probeQuarantinedMutation(chromeApi, tabId, timeoutMs=2500) {
  let timer;
  const execution=chromeApi.scripting.executeScript({
    target:{tabId,frameIds:[0]},world:'ISOLATED',
    func:()=>{
      const lock=globalThis.__chromeBridgeMutationLock;
      const terminal=globalThis.__chromeBridgeMutationTerminal;
      return {
        href:location.href,
        origin:location.origin,
        lock:lock ? {
          requestId:lock.requestId,name:lock.name,startedAt:lock.startedAt
        } : null,
        terminal:terminal ? {
          schemaVersion:terminal.schemaVersion,
          requestId:terminal.requestId,command:terminal.command,
          origin:terminal.origin,conversationId:terminal.conversationId,
          startedAt:terminal.startedAt,completedAt:terminal.completedAt,
          state:terminal.state,clickAttempted:terminal.clickAttempted===true,
          clickReturned:terminal.clickReturned===true,
          payloadHash:typeof terminal.payloadHash==='string'?terminal.payloadHash:null,
          preparedId:typeof terminal.preparedId==='string'?terminal.preparedId:null
        } : null
      };
    }
  });
  const outcome=await Promise.race([
    execution.then(value=>({settled:true,value}),error=>({settled:true,error})),
    new Promise(resolve=>{timer=setTimeout(()=>resolve({settled:false}),timeoutMs);})
  ]);
  clearTimeout(timer);
  if (!outcome.settled) throw coordinatorError('QUARANTINE_PROOF_TIMEOUT','BLOCKED');
  if (outcome.error) throw coordinatorError('QUARANTINE_PROOF_UNAVAILABLE','BLOCKED');
  const frames=outcome.value;
  const main=Array.isArray(frames) ? frames.find(frame=>frame.frameId===0) : null;
  if (!main?.documentId || !main.result || typeof main.result!=='object')
    throw coordinatorError('QUARANTINE_PROOF_UNAVAILABLE','BLOCKED');
  return {
    ...main.result,documentId:main.documentId,frameId:main.frameId
  };
}

async function reconcileQuarantinedTab(chromeApi, {
  tabId,token,confirmed,localGesture
}={}) {
  if (!Number.isSafeInteger(tabId) || tabId<=0)
    throw coordinatorError('INVALID_QUARANTINE_TAB','BLOCKED');
  if (confirmed!==true || localGesture!==true)
    throw coordinatorError('OPERATOR_CONFIRMATION_REQUIRED','BLOCKED');
  return enqueueRevocationFence(async()=>{
    const state=await readQuarantineSnapshot(chromeApi);
    if (state.globalLock)
      throw coordinatorError('GLOBAL_QUARANTINE_LOCK_REQUIRES_SEPARATE_REVIEW','BLOCKED');
    if (!state.quarantinedTabs.includes(tabId))
      throw coordinatorError('QUARANTINE_NOT_FOUND','BLOCKED');
    const record=state.records[String(tabId)];
    const stores=state.recordStores[String(tabId)] || [];
    if (!record || !stores.length || typeof token!=='string' || record.token!==token)
      throw coordinatorError('QUARANTINE_TOKEN_STALE','BLOCKED');

    // Session Authorization is origin-wide. Report this policy boundary before
    // inspecting in-flight tab state or probing the page, and do not mutate grants.
    const sessionStatus=await new SessionAuthorization(chromeApi).status();
    if (sessionStatus.active && sessionStatus.origins.includes(record.origin))
      throw coordinatorError('SESSION_WIDE_REVOCATION_REQUIRED','BLOCKED');
    if (mutationLanes.has(tabId) || mutationFencedTabs.has(tabId))
      throw coordinatorError('QUARANTINE_ACTION_STILL_RUNNING','BLOCKED');

    const pendingGlobal=state.global.record;
    if (pendingGlobal?.pending===true) {
      const affected=pendingGlobal.affectedTabs;
      if (!Array.isArray(affected) || affected.length===0 ||
          affected.some(id=>!Number.isSafeInteger(id)||id<=0) ||
          new Set(affected).size!==affected.length || !affected.includes(tabId))
        throw coordinatorError('GLOBAL_FENCE_SCOPE_INVALID','BLOCKED');
      const operations=pendingGlobal.operations;
      if (!Array.isArray(operations))
        throw coordinatorError('GLOBAL_FENCE_OPERATIONS_UNAVAILABLE','BLOCKED');
      const operation=operations.find(item=>item?.tabId===tabId);
      if (!operation ||
          (operation.operationId!==undefined && operation.operationId!==record.operationId) ||
          operation.requestId!==record.requestId ||
          operation.command!==record.command || operation.origin!==record.origin ||
          operation.conversationId!==record.conversationId ||
          (operation.documentId!==undefined && operation.documentId!==record.documentId) ||
          (operation.frameId!==undefined && operation.frameId!==record.frameId) ||
          (operation.operationId && Number.isFinite(record.startedAt) &&
            Number.isFinite(operation.startedAt) && operation.startedAt!==record.startedAt) ||
          (record.taskId && operation.taskId!==record.taskId) ||
          (record.providerId && operation.providerId!==record.providerId) ||
          (Number.isSafeInteger(record.epoch) && operation.epoch!==record.epoch) ||
          (record.payloadHash && operation.payloadHash!==record.payloadHash) ||
          (record.preparedId && operation.preparedId!==record.preparedId))
        throw coordinatorError('GLOBAL_FENCE_OPERATION_IDENTITY_MISMATCH','BLOCKED');
    }
    if (record.reconcilable!==true ||
        typeof record.operationId!=='string' ||
        !record.requestId ||
        !['provider_prepare','provider_commit'].includes(record.command) ||
        typeof record.origin!=='string' ||
        typeof record.conversationId!=='string' ||
        typeof record.documentId!=='string' || !record.documentId ||
        record.frameId!==0)
      throw coordinatorError('QUARANTINE_PROOF_NOT_BINDABLE','BLOCKED');

    const {tab,origin,site}=await permittedTab(chromeApi,tabId);
    if (origin!==record.origin || site?.mode!=='chat' ||
        typeof site.adapter!=='string' ||
        !new URL(tab.url).pathname.split('/').includes(record.conversationId))
      throw coordinatorError('QUARANTINE_TAB_IDENTITY_CHANGED','BLOCKED');
    const probe=await probeQuarantinedMutation(chromeApi,tabId);
    if (probe.href!==tab.url || probe.origin!==record.origin)
      throw coordinatorError('QUARANTINE_TAB_IDENTITY_CHANGED','BLOCKED');
    if (probe.documentId!==record.documentId)
      throw coordinatorError('QUARANTINE_DOCUMENT_IDENTITY_CHANGED','BLOCKED');
    if (probe.lock)
      throw coordinatorError('QUARANTINE_ACTION_STILL_RUNNING','BLOCKED');
    const terminal=probe.terminal;
    if (!terminal || terminal.schemaVersion!==1 ||
        terminal.requestId!==record.requestId ||
        terminal.command!==record.command ||
        terminal.origin!==record.origin ||
        terminal.conversationId!==record.conversationId ||
        !Number.isFinite(record.startedAt) ||
        !Number.isFinite(terminal.startedAt) ||
        !Number.isFinite(terminal.completedAt) ||
        terminal.startedAt<record.startedAt ||
        terminal.completedAt<terminal.startedAt ||
        terminal.completedAt>Date.now()+1000 ||
        (record.payloadHash && terminal.payloadHash!==record.payloadHash) ||
        (record.preparedId && terminal.preparedId!==record.preparedId) ||
        (record.command==='provider_commit'
          ? (!['COMMIT_CLICK_ATTEMPTED','COMMIT_NOT_CLICKED'].includes(terminal.state) ||
             terminal.clickAttempted!==(terminal.state==='COMMIT_CLICK_ATTEMPTED'))
          : (!['PREPARE_MUTATION_FINISHED','PREPARE_NO_MUTATION'].includes(terminal.state) ||
             terminal.clickAttempted===true || terminal.clickReturned===true)))
      throw coordinatorError('QUARANTINE_TERMINAL_EVIDENCE_MISMATCH','BLOCKED');

    // Re-read the record after the page probe. A newer Revoke/quarantine token
    // always wins over the operator's stale preview.
    const latest=await readQuarantineSnapshot(chromeApi);
    const latestRecord=latest.records[String(tabId)];
    const latestTab=await permittedTab(chromeApi,tabId);
    if (!latestRecord || latestRecord.token!==record.token ||
        !latest.quarantinedTabs.includes(tabId) || latest.globalLock ||
        latestTab.tab.url!==tab.url || latestTab.origin!==record.origin)
      throw coordinatorError('QUARANTINE_TOKEN_STALE','BLOCKED');

    const backgroundGrants=new BackgroundControlGrants(chromeApi);
    const grantRevoke=await enqueueControlOperationBounded(
      ()=>backgroundGrants.revoke(tabId),
      {tabId,allowFencedTab:true}
    );
    if (!grantRevoke.settled)
      throw coordinatorError('QUARANTINE_GRANT_REVOKE_UNCONFIRMED','BLOCKED');
    if (await backgroundGrants.require(record.origin,tabId)!==null)
      throw coordinatorError('QUARANTINE_GRANT_STILL_ACTIVE','BLOCKED');

    const auditEvent={
      schemaVersion:1,eventId:crypto.randomUUID(),type:'OPERATOR_RECONCILE',
      tabId,quarantineToken:record.token,operationId:record.operationId,
      requestId:record.requestId,command:record.command,origin:record.origin,
      trustBoundary:'LOCAL_MACHINE_TRUSTED_CONTROL_UI',
      conversationId:record.conversationId,reasonCode:record.reasonCode,
      globalFenceToken:state.global.record?.token || null,
      evidence:{
        terminalState:terminal.state,
        startedAt:terminal.startedAt,completedAt:terminal.completedAt,
        clickAttempted:terminal.clickAttempted===true,
        clickReturned:terminal.clickReturned===true,
        documentId:probe.documentId,frameId:probe.frameId
      },
      backgroundGrantRevokedAndVerified:true,
      sessionAuthorizationAbsent:true,
      confirmed:true,localGesture:true,reconciledAt:Date.now()
    };
    // Audit is durable before any deny marker is removed. Keep the complete
    // sequence; if storage quota is exhausted, reconciliation stops fail-closed.
    for (const store of stores) {
      const storage=store==='local'?chromeApi.storage.local:chromeApi.storage.session;
      const current=await storage.get('bridgeMutationQuarantineAudit');
      const prior=Array.isArray(current.bridgeMutationQuarantineAudit)
        ? current.bridgeMutationQuarantineAudit : [];
      await storage.set({bridgeMutationQuarantineAudit:[...prior,auditEvent]});
    }

    // If this tab is the last unresolved member of a recovered global Revoke,
    // persist and verify every tab's token-bound audit before removing the
    // global fence. The tab quarantine remains in place until its own cleanup
    // completes, so a partial write never opens the affected tab.
    const afterAudit=await readQuarantineSnapshot(chromeApi);
    const pending=afterAudit.global.record;
    if (pending?.pending===true) {
      const affected=pending.affectedTabs;
      if (!Array.isArray(affected) || affected.length===0 ||
          affected.some(id=>!Number.isSafeInteger(id)||id<=0) ||
          new Set(affected).size!==affected.length || !affected.includes(tabId))
        throw coordinatorError('GLOBAL_FENCE_SCOPE_INVALID','BLOCKED');
      const unresolvedOther=affected.filter(id=>
        id!==tabId && afterAudit.quarantinedTabs.includes(id));
      const auditResolved=affected.every(id=>{
        const currentRecord=afterAudit.records[String(id)];
        return afterAudit.audits.some(event=>
          event?.type==='OPERATOR_RECONCILE' && event.tabId===id &&
          event.globalFenceToken===pending.token &&
          typeof event.quarantineToken==='string' &&
          Number.isFinite(event.reconciledAt) &&
          (currentRecord ? event.quarantineToken===currentRecord.token :
            event.quarantineToken.length>0) &&
          (id!==tabId || event.quarantineToken===record.token));
      });
      if (unresolvedOther.length===0 && auditResolved &&
          !await clearGlobalRevocationFence(chromeApi,pending,afterAudit.global.stores))
        throw coordinatorError('GLOBAL_FENCE_CLEAR_UNCONFIRMED','BLOCKED');
    }

    // Remove a tab-scoped admission marker from every store before deleting
    // only the matching quarantine token. A failed write leaves the record
    // visible and retryable; unrelated/newer entries are never removed.
    const fenceStores=['local','session'];
    if (!await clearTabRevocationFence(chromeApi,tabId,fenceStores))
      throw coordinatorError('QUARANTINE_FENCE_CLEANUP_UNCONFIRMED','BLOCKED');

    for (const store of stores) {
      const storage=store==='local'?chromeApi.storage.local:chromeApi.storage.session;
      const current=await storage.get([
        'bridgeMutationQuarantinedTabs','bridgeMutationQuarantineRecords'
      ]);
      const currentRecords=current.bridgeMutationQuarantineRecords &&
        typeof current.bridgeMutationQuarantineRecords==='object'
        ? current.bridgeMutationQuarantineRecords : {};
      if (currentRecords[String(tabId)]?.token!==record.token)
        throw coordinatorError('QUARANTINE_TOKEN_STALE','BLOCKED');
      const nextRecords={...currentRecords};
      delete nextRecords[String(tabId)];
      const priorTabs=Array.isArray(current.bridgeMutationQuarantinedTabs)
        ? current.bridgeMutationQuarantinedTabs : [];
      await storage.set({
        bridgeMutationQuarantinedTabs:priorTabs.filter(id=>id!==tabId),
        bridgeMutationQuarantineRecords:nextRecords
      });
    }
    mutationQuarantinedTabs.delete(tabId);
    const deliveryState=terminal.clickAttempted===true?'UNKNOWN':'NOT_SENT';
    return {
      ok:true,tabId,operationId:record.operationId,requestId:record.requestId,
      state:'RECONCILED',terminalState:terminal.state,deliveryState,
      warning:terminal.clickAttempted===true
        ? 'SEND_CLICK_ATTEMPTED_DELIVERY_UNKNOWN_DO_NOT_REPLAY'
        : record.command==='provider_prepare' && terminal.state==='PREPARE_MUTATION_FINISHED'
          ? 'NO_SEND_COMPOSER_DRAFT_MAY_REMAIN_INSPECT_AND_CLEAR'
          : 'NO_SEND_CLICK_CONFIRMED_NOT_SENT',
      auditEventId:auditEvent.eventId
    };
  });
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
  try { await ensureMutationOperationRecovery(chromeApi); }
  catch { return {ok:false,reason:'MUTATION_OPERATION_JOURNAL_UNAVAILABLE'}; }
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
    await ensureMutationOperationRecovery(chromeApi);
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
    await cancelActiveMutationOperations(chromeApi);
    const mutationDrain = await drainMutationLanes(chromeApi,stopDrainTimeoutMs);
    await quarantineUnreconciledGenericActions(chromeApi);
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
  void ensureMutationOperationRecovery(chromeApi).catch(()=>{});
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
      const run = async (activateMutationContext=null) => {
        const failureStartedAt=Date.now();
        const name=msg.command?.name;
        const sessionControlChange = name==='session_authorize' || name==='session_revoke';
        if (sessionControlChange && controlClearRequested)
          throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS','BLOCKED');
        // Capture the active operation before cancelling approvals or awaiting
        // recovery/storage. Queued operations have not activated their context
        // and therefore cannot overwrite this snapshot.
        const revocationContextSnapshot=name==='session_revoke'
          ? new Map([...mutationContexts.entries()].map(([id,context])=>[id,{...context}]))
          : null;
        const revocationTabIds=name==='session_revoke'
          ? [...new Set([...mutationLanes.keys(),...mutationContexts.keys()])]
          : null;
        if (sessionControlChange) controlClearRequested=true;
        if (name==='session_revoke') approvals.stop();
        let globalRevocationFence=null;

        try {
          if (MUTATION_COMMANDS.has(name) || sessionControlChange)
            await ensureMutationOperationRecovery(chromeApi);
          // Persist the global deny fence before the first asynchronous step.
          // A replacement worker will reject every mutation until Revoke is
          // reconciled; affected tabs are quarantined if this is a recovery.
          if (name==='session_revoke') {
            globalRevocationFence=await enqueueRevocationFence(
              ()=>persistGlobalRevocationFence(chromeApi,revocationTabIds,
                revocationContextSnapshot)
            );
            if (!globalRevocationFence.persisted) {
              await persistGlobalQuarantineLock(chromeApi);
              throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED','UNKNOWN');
            }
          }
          const {bridgeBackgroundMode,bridgeMutationLabMode,bridgeConnectionDesired} =
            await chromeApi.storage.local.get([
              'bridgeBackgroundMode','bridgeMutationLabMode','bridgeConnectionDesired'
            ]);
          if (bridgeBackgroundMode!==true || bridgeConnectionDesired!==true)
            throw coordinatorError('BACKGROUND_TRANSPORT_DISABLED','BLOCKED');

          const sessionAuthorization=new SessionAuthorization(chromeApi);
          if (name==='session_authorize') {
            try {
              const pendingRevocation=await readGlobalRevocationFence(chromeApi);
              if (pendingRevocation.record)
                throw coordinatorError('BACKGROUND_CONTROL_CLEAR_IN_PROGRESS','BLOCKED');
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
            const recovered=globalRevocationFence.existing===true;
            const affectedTabs=Array.isArray(globalRevocationFence.record?.affectedTabs)
              ? globalRevocationFence.record.affectedTabs : [];
            let recoveredQuarantinedTabs=[];
            if (recovered && affectedTabs.length) {
              const quarantine=await persistMutationQuarantine(chromeApi,affectedTabs,
                globalRevocationFence.record?.operations);
              if (!quarantine.persisted) {
                const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
                error.quarantinedTabs=affectedTabs;
                throw error;
              }
              recoveredQuarantinedTabs=quarantine.quarantinedTabs||[];
            }
            await cancelActiveMutationOperations(chromeApi);
            const drained=await drainMutationLanes(chromeApi);
            await quarantineUnreconciledGenericActions(chromeApi);
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
              if (drained.quarantinePersisted!==true) {
                await persistGlobalQuarantineLock(chromeApi);
                const error=coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','UNKNOWN');
                error.quarantinedTabs=drained.tabIds;
                throw error;
              }
              const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
              error.quarantinedTabs=drained.tabIds;
              throw error;
            }
            if (cleanupError) {
              await persistGlobalQuarantineLock(chromeApi);
              throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED','UNKNOWN');
            }
            // A prior worker's operation is still UNKNOWN. Keep the global
            // admission fence until every affected tab has independently
            // supplied terminal page-action evidence to operator reconciliation.
            if (recoveredQuarantinedTabs.length) {
              const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
              error.quarantinedTabs=recoveredQuarantinedTabs;
              throw error;
            }
            const fenceCleared=await enqueueRevocationFence(
              ()=>clearGlobalRevocationFence(chromeApi,globalRevocationFence.record,
                globalRevocationFence.stores)
            );
            if (!fenceCleared) {
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
            activateMutationContext?.();
            const grants=new BackgroundControlGrants(chromeApi);
            // Guard approval creation at the point it is requested, not
            // only when the mutation first enters its lane. Preflight awaits
            // can overlap a Revoke; this prevents a late approval appearing
            // after cancelTab() has already run.
            const guardedApprovals={
              request:async data=>{
                await assertMutationAllowed(chromeApi,data.tabId);
                return approvals.request(data);
              }
            };
            try {
              const result=await dispatchMutation(msg.command,chromeApi,{
                approvals:guardedApprovals,
                sessionAuthorization,
                operationJournal:mutationOperationJournalFor(chromeApi),
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
              // A generic page click/fill has no provider-specific receipt that
              // proves the site's asynchronous side effects have settled. Keep
              // the exact tab quarantined before acknowledging completion; a
              // later action must not race the unresolved site-side effect.
              if (['browser_click','browser_fill'].includes(name)) {
                const tabId=msg.command?.args?.tabId;
                const persisted=await persistMutationQuarantine(chromeApi,[tabId]);
                if (!persisted.persisted) {
                  await persistGlobalQuarantineLock(chromeApi);
                  const error=coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','UNKNOWN');
                  error.quarantinedTabs=[tabId];
                  throw error;
                }
                // The quarantine supersedes the tab's prior explicit grant.
                // Clear that session grant before acknowledging the click/fill;
                // the durable quarantine remains even if this write fails.
                try {
                  await new BackgroundControlGrants(chromeApi).revoke(tabId);
                } catch {
                  await persistGlobalQuarantineLock(chromeApi);
                  const error=coordinatorError('MUTATION_QUARANTINE_GRANT_REVOKE_FAILED','UNKNOWN');
                  error.quarantinedTabs=[tabId];
                  throw error;
                }
                if (result && typeof result==='object') result.mutationQuarantined=true;
                else return {result,mutationQuarantined:true};
              }
              return result;
            } catch(error) {
              if (error?.dispatchState==='UNKNOWN') {
                const tabId=msg.command?.args?.tabId;
                if (Number.isSafeInteger(tabId) && tabId>0) {
                  const quarantine=await persistMutationQuarantine(chromeApi,[tabId]);
                  error.quarantinedTabs=[tabId];
                  if (!quarantine.persisted) await persistGlobalQuarantineLock(chromeApi);
                }
              }
              throw error;
            }
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
        quarantinedTabs:Array.isArray(error?.quarantinedTabs) ? error.quarantinedTabs : [],
        failure:normalizeFailure(error?.failure,{
          stage:'PRECHECK',
          code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message||'')
            ? error.message : 'COORDINATOR_DISPATCH_FAILED',
          startedAt:Date.now()
        })
      });

      if (MUTATION_COMMANDS.has(msg.command?.name)) {
        const tabId=msg.command?.args?.tabId;
        const mutationArgs=msg.command?.args || {};
        const context={
          requestId:mutationArgs.requestId,
          command:msg.command?.name,
          taskId:mutationArgs.taskId,
          providerId:mutationArgs.providerId,
          origin:mutationArgs.origin || mutationArgs.expectedOrigin,
          conversationId:mutationArgs.conversationId || mutationArgs.expectedConversationId,
          epoch:mutationArgs.epoch,
          payloadHash:mutationArgs.payloadHash,
          preparedId:mutationArgs.preparedId
        };
        let accepted;
        try {
          accepted=enqueueTabMutation(tabId,activateMutationContext=>
            run(activateMutationContext),context);
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
    if (msg.type === 'quarantine-status') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      void ensureMutationOperationRecovery(chromeApi)
        .then(()=>readQuarantineStatus(chromeApi))
        .then(respond,e=>respond({
          available:false,error:/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message||'')
            ? e.message : 'QUARANTINE_STATUS_UNAVAILABLE'
        }));
      return true;
    }
    if (msg.type === 'reconcile-quarantine') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({ok:false,error:'CONTROL_PANEL_REQUIRED',outcome:'NOT_PERFORMED'}); return false;
      }
      void ensureMutationOperationRecovery(chromeApi)
        .then(()=>reconcileQuarantinedTab(chromeApi,msg))
        .then(respond,e=>respond({
          ok:false,error:/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message||'')
            ? e.message : 'QUARANTINE_RECONCILIATION_FAILED',
          outcome:e?.dispatchState==='BLOCKED' ? 'NOT_PERFORMED' : 'UNKNOWN',
          dispatchState:e?.dispatchState==='BLOCKED' ? 'BLOCKED' : 'UNKNOWN'
        }));
      return true;
    }
    if (msg.type === 'clear-background-controls') {
      if (sender.url !== chromeApi.runtime.getURL('control.html')) {
        respond({error:'CONTROL_PANEL_REQUIRED'}); return false;
      }
      // Revoke-all is a global mutation fence. No accepted page action may
      // continue after the UI receives a successful clear response.
      if (controlClearRequested || mutationStopCount>0) {
        respond({error:'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS',outcome:'NOT_PERFORMED'});
        return false;
      }
      // Snapshot only the currently active operation before cancelling
      // approvals. Later queued requests are not part of this Revoke scope.
      const revocationContextSnapshot=new Map(
        [...mutationContexts.entries()].map(([id,context])=>[id,{...context}])
      );
      const revocationTabIds=[...mutationLanes.keys()];
      controlClearRequested = true;
      // Revoke-all cancels every outstanding approval before draining lanes.
      approvals.stop();
      void (async()=>{
        await ensureMutationOperationRecovery(chromeApi);
        const fence=await enqueueRevocationFence(
          ()=>persistGlobalRevocationFence(chromeApi,revocationTabIds,
            revocationContextSnapshot)
        );
        if (!fence.persisted) {
          await persistGlobalQuarantineLock(chromeApi);
          throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED','UNKNOWN');
        }
        const recovered=fence.existing===true;
        const affectedTabs=Array.isArray(fence.record?.affectedTabs)?fence.record.affectedTabs:[];
        let recoveredQuarantinedTabs=[];
        if (recovered && affectedTabs.length) {
          const quarantine=await persistMutationQuarantine(chromeApi,affectedTabs,fence.record?.operations);
          if (!quarantine.persisted) {
            const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
            error.quarantinedTabs=affectedTabs;
            throw error;
          }
          recoveredQuarantinedTabs=quarantine.quarantinedTabs||[];
        }
        let cleanupError=null;
        await cancelActiveMutationOperations(chromeApi);
        const drained=await drainMutationLanes(chromeApi);
        await quarantineUnreconciledGenericActions(chromeApi);
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
          if (drained.quarantinePersisted!==true) {
            await persistGlobalQuarantineLock(chromeApi);
            const error=coordinatorError('MUTATION_QUARANTINE_STATE_UNAVAILABLE','UNKNOWN');
            error.quarantinedTabs=drained.tabIds;
            throw error;
          }
          const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
          error.quarantinedTabs=drained.tabIds;
          throw error;
        }
        if (cleanupError) {
          await persistGlobalQuarantineLock(chromeApi);
          throw coordinatorError('BACKGROUND_CONTROL_CLEAR_FAILED','UNKNOWN');
        }
        // A prior worker's accepted operation remains UNKNOWN. Keep the
        // global admission fence until operator reconciliation has verified
        // terminal evidence for every affected tab.
        if (recoveredQuarantinedTabs.length) {
          const error=coordinatorError('BACKGROUND_STOP_UNCONFIRMED','UNKNOWN');
          error.quarantinedTabs=recoveredQuarantinedTabs;
          throw error;
        }
        const cleared=await enqueueRevocationFence(
          ()=>clearGlobalRevocationFence(chromeApi,fence.record,fence.stores)
        );
        if (!cleared) {
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
        // A per-tab Revoke must not wait for a stale approval dialog to expire.
        // Cancel only this tab's pending approvals before the first async drain;
        // the mutation lane then settles as BLOCKED without entering pageAction.
        approvals.cancelTab(tabId);
        const revoke=async()=>{
          let revokeWriteStarted=false;
          let fenceStores=[];
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
            await ensureMutationOperationRecovery(chromeApi);
            const fence=await enqueueRevocationFence(()=>persistTabRevocationFence(chromeApi,tabId));
            if (!fence.persisted) throw await unknownRevoke();
            fenceStores=fence.stores;

            await cancelActiveMutationOperations(chromeApi,[tabId]);
            const pending=mutationLanes.get(tabId);
            const settled=await awaitBounded(pending,STOP_DRAIN_TIMEOUT_MS);
            if (!settled) throw await unknownRevoke();
            await quarantineUnreconciledGenericActions(chromeApi,[tabId]);

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

            if (!await enqueueRevocationFence(()=>clearTabRevocationFence(chromeApi,tabId,fenceStores)))
              throw await unknownRevoke();
            fenceCleared=true;
            return {ok:true,tabId};
          } catch (error) {
            // A precondition denial is safe to return only after removing the
            // durable admission fence. Failed/ambiguous revoke writes retain a
            // permanent quarantine rather than reopening the tab.
            if (!keepFence && fenceStores.length && !fenceCleared) {
              try {
                fenceCleared=await enqueueRevocationFence(()=>clearTabRevocationFence(chromeApi,tabId,fenceStores));
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
          await ensureMutationOperationRecovery(chromeApi);
          const {bridgeMutationLabMode,bridgeConnectionDesired}=await chromeApi.storage.local.get(
            ['bridgeMutationLabMode','bridgeConnectionDesired']
          );
          if (mutationStopRequested || controlClearRequested ||
              bridgeMutationLabMode!==true || bridgeConnectionDesired!==true)
            throw coordinatorError('BACKGROUND_CONTROL_DISABLED','BLOCKED');
          // Control-plane grants must honor the same durable fences as page
          // mutations; a replacement MV3 worker has no in-memory revoke flags.
          await assertMutationAllowed(chromeApi,msg.tabId);
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
