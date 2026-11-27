const PREFIX = 'bridgeMutationOperation.v1.';
const INDEX_KEY = PREFIX + 'index';
const MAX_RECORDS = 5000;
const COMMANDS = new Set(['browser_click','browser_fill','agent_send','provider_prepare','provider_commit']);
const PHASES = new Set(['ACCEPTED','INJECTING','COMPLETED','ABORTED_BEFORE_INJECTION','UNKNOWN']);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const OUTCOMES = new Set(['COMPLETED','NOT_PERFORMED','UNKNOWN','PREPARED','CLICKED','FILLED']);
const SAFE_SIDE_EFFECTS = new Set([
  'none','composer-filled-no-send','composer-draft-state-unverified',
  'send-click-may-have-fired','provider-send-clicked','agent-send-clicked','generic-page-action',
  'generic-page-action-may-have-fired','operation-result-unverified'
]);
const lanes = new WeakMap();

function enqueue(api, task) {
  const prior = lanes.get(api) || Promise.resolve();
  const next = prior.catch(() => {}).then(task);
  lanes.set(api, next);
  void next.catch(() => {});
  return next;
}
function keyFor(id) { return PREFIX + id; }
function hasExactKeys(value, keys) {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  return actual.length===expected.length && actual.every((key,index)=>key===expected[index]);
}
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value); }
function validHttpsOrigin(value) {
  if (typeof value!=='string') return false;
  try {
    const parsed=new URL(value);
    return parsed.protocol==='https:' && parsed.origin===value && !parsed.username && !parsed.password;
  } catch { return false; }
}
function safeCode(value, fallback) { return SAFE_CODE.test(value || '') ? value : fallback; }
function safeSideEffect(value) { return SAFE_SIDE_EFFECTS.has(value) ? value : null; }
async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}
function identityBody(record) {
  return JSON.stringify({
    schemaVersion:record.schemaVersion,operationId:record.operationId,
    command:record.command,tabId:record.tabId,origin:record.origin,
    urlSha256:record.urlSha256,documentId:record.documentId,frameId:record.frameId,
    conversationId:record.conversationId,requestId:record.requestId,
    taskId:record.taskId,providerId:record.providerId,preparedId:record.preparedId,
    payloadHash:record.payloadHash,epoch:record.epoch,createdAt:record.createdAt
  });
}
function eventBody(event) {
  return JSON.stringify({
    identityHash:event.identityHash,seq:event.seq,phase:event.phase,at:event.at,
    code:event.code,outcome:event.outcome,sideEffect:event.sideEffect,
    documentId:event.documentId,frameId:event.frameId,prevHash:event.prevHash
  });
}
async function makeEvent(previous, phase, metadata={}, now=Date.now, identityHash) {
  const event = {
    identityHash,seq:previous ? previous.seq+1 : 1, phase, at:now(),
    code:safeCode(metadata.code || '',null),
    outcome:typeof metadata.outcome === 'string' &&
      ['COMPLETED','NOT_PERFORMED','UNKNOWN','PREPARED','CLICKED','FILLED'].includes(metadata.outcome)
        ? metadata.outcome : null,
    sideEffect:safeSideEffect(metadata.sideEffect),
    documentId:typeof metadata.documentId === 'string' ? metadata.documentId.slice(0,200) : null,
    frameId:Number.isSafeInteger(metadata.frameId) && metadata.frameId >= 0 ? metadata.frameId : null,
    prevHash:previous?.hash || null
  };
  event.hash=await sha256(eventBody(event));
  return event;
}
function indexEventBody(event) {
  return JSON.stringify({
    seq:event.seq,operationId:event.operationId,
    identityHash:event.identityHash,prevHash:event.prevHash
  });
}
function emptyIndex() {
  return {schemaVersion:1,count:0,events:[]};
}
async function verifyIndex(index,recordRows) {
  const keys=Object.keys(recordRows);
  if (!index && keys.length===0) return emptyIndex();
  if (!hasExactKeys(index,['schemaVersion','count','events']) || index.schemaVersion!==1 ||
      !Number.isSafeInteger(index.count) || index.count<0 ||
      !Array.isArray(index.events) || index.count!==index.events.length ||
      index.count>MAX_RECORDS || index.count!==keys.length)
    throw Error('MUTATION_OPERATION_INDEX_CORRUPT');
  const seen=new Set();
  let previous=null;
  for (const event of index.events) {
    if (!hasExactKeys(event,['seq','operationId','identityHash','prevHash','hash']) ||
        !Number.isSafeInteger(event.seq) || event.seq!==(previous?.seq||0)+1 ||
        !validId(event.operationId) || seen.has(event.operationId) ||
        typeof event.identityHash!=='string' || !/^[a-f0-9]{64}$/.test(event.identityHash) ||
        event.prevHash!==(previous?.hash||null) ||
        typeof event.hash!=='string' || !/^[a-f0-9]{64}$/.test(event.hash) ||
        await sha256(indexEventBody(event))!==event.hash)
      throw Error('MUTATION_OPERATION_INDEX_CORRUPT');
    const key=keyFor(event.operationId);
    const record=recordRows[key];
    if (!record || record.operationId!==event.operationId ||
        record.identityHash!==event.identityHash)
      throw Error('MUTATION_OPERATION_INDEX_RECORD_MISMATCH');
    await verifyRecord(record,event.operationId);
    seen.add(event.operationId);
    previous=event;
  }
  if (seen.size!==keys.length) throw Error('MUTATION_OPERATION_INDEX_ORPHAN_RECORD');
  return index;
}
async function appendIndex(index,operationId,identityHash) {
  const previous=index.events.at(-1)||null;
  const event={
    seq:index.count+1,operationId,identityHash,prevHash:previous?.hash||null
  };
  event.hash=await sha256(indexEventBody(event));
  return {
    schemaVersion:1,count:index.count+1,
    events:[...index.events,event]
  };
}

async function verifyRecord(record, operationId) {
  if (!hasExactKeys(record,[
      'schemaVersion','operationId','command','tabId','origin','urlSha256',
      'documentId','frameId','conversationId','requestId','taskId','providerId',
      'preparedId','payloadHash','epoch','createdAt','updatedAt','identityHash','events'
    ]) ||
      record.schemaVersion !== 1 || record.operationId !== operationId ||
      !validId(record.operationId) || !Number.isSafeInteger(record.tabId) || record.tabId <= 0 ||
      !COMMANDS.has(record.command) || typeof record.origin !== 'string' ||
      !validHttpsOrigin(record.origin) || typeof record.urlSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.urlSha256) ||
      typeof record.identityHash!=='string' || !/^[a-f0-9]{64}$/.test(record.identityHash) ||
      await sha256(identityBody(record))!==record.identityHash ||
      typeof record.documentId !== 'string' || !record.documentId || record.documentId.length>200 ||
      record.frameId !== 0 ||
      !['conversationId','requestId','taskId','providerId','preparedId','payloadHash','epoch'].every(key=>
        record[key]===null || (key==='epoch'?Number.isSafeInteger(record[key])&&record[key]>0:
          typeof record[key]==='string' && record[key].length<=160 &&
          (key!=='payloadHash' || /^[a-f0-9]{64}$/.test(record[key])))) ||
      !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) ||
      record.updatedAt<record.createdAt || !Array.isArray(record.events) ||
      record.events.length < 1 || record.events.length > 3)
    throw Error('MUTATION_OPERATION_JOURNAL_CORRUPT');
  let previous=null;
  for (const event of record.events) {
    if (!hasExactKeys(event,[
        'identityHash','seq','phase','at','code','outcome','sideEffect',
        'documentId','frameId','prevHash','hash'
      ]) || !Number.isSafeInteger(event.seq) || event.seq !== (previous?.seq || 0)+1 ||
        !PHASES.has(event.phase) || !Number.isFinite(event.at) ||
        (event.code!==null && (typeof event.code!=='string' || !SAFE_CODE.test(event.code))) ||
        (event.outcome!==null && !OUTCOMES.has(event.outcome)) ||
        (event.sideEffect!==null && !SAFE_SIDE_EFFECTS.has(event.sideEffect)) ||
        (event.documentId!==null && (typeof event.documentId!=='string' || !event.documentId || event.documentId.length>200)) ||
        (event.frameId!==null && (!Number.isSafeInteger(event.frameId) || event.frameId<0)) ||
        event.identityHash!==record.identityHash ||
        event.prevHash !== (previous?.hash || null) ||
        typeof event.hash !== 'string' || !/^[a-f0-9]{64}$/.test(event.hash) ||
        await sha256(eventBody(event)) !== event.hash)
      throw Error('MUTATION_OPERATION_JOURNAL_CORRUPT');
    previous=event;
  }
  const expectedUpdatedAt=Math.max(record.createdAt,...record.events.map(event=>event.at));
  if (record.updatedAt!==expectedUpdatedAt)
    throw Error('MUTATION_OPERATION_JOURNAL_CORRUPT');
  if (record.events[0].phase !== 'ACCEPTED') throw Error('MUTATION_OPERATION_JOURNAL_CORRUPT');
  const phases=record.events.map(event=>event.phase);
  const valid =
    (phases.length===1 && phases[0]==='ACCEPTED') ||
    (phases.length===2 && phases[0]==='ACCEPTED' &&
      ['INJECTING','ABORTED_BEFORE_INJECTION'].includes(phases[1])) ||
    (phases.length===3 && phases[0]==='ACCEPTED' && phases[1]==='INJECTING' &&
      ['COMPLETED','UNKNOWN'].includes(phases[2]));
  if (!valid) throw Error('MUTATION_OPERATION_JOURNAL_CORRUPT');
  return record;
}
export class MutationOperationJournal {
  constructor(chromeApi,{now=Date.now,uuid=()=>crypto.randomUUID()}={}) {
    this.api=chromeApi; this.now=now; this.uuid=uuid;
  }
  async #storage() {
    const storage=this.api?.storage?.local;
    if (!storage?.get || !storage?.set || !storage?.setAccessLevel)
      throw Error('MUTATION_OPERATION_JOURNAL_UNAVAILABLE');
    try { await storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}); }
    catch { throw Error('MUTATION_OPERATION_JOURNAL_UNAVAILABLE'); }
    return storage;
  }
  async #read(storage,id) {
    let value;
    try { value=await storage.get(keyFor(id)); }
    catch { throw Error('MUTATION_OPERATION_JOURNAL_UNAVAILABLE'); }
    const record=value?.[keyFor(id)];
    if (!record) throw Error('MUTATION_OPERATION_RECORD_NOT_FOUND');
    return verifyRecord(record,id);
  }
  async #appendUnlocked(storage,id,phase,metadata={}) {
    const current=await this.#read(storage,id);
    const previous=current.events[current.events.length-1];
    const allowed=previous.phase==='ACCEPTED'
      ? ['INJECTING','ABORTED_BEFORE_INJECTION']
      : previous.phase==='INJECTING' ? ['COMPLETED','UNKNOWN'] : [];
    if (!allowed.includes(phase)) throw Error('MUTATION_OPERATION_TRANSITION_DENIED');
    if (phase==='INJECTING' && (metadata.documentId!==current.documentId ||
        metadata.frameId!==current.frameId))
      throw Error('MUTATION_OPERATION_DOCUMENT_IDENTITY_MISMATCH');
    if (metadata.documentId && metadata.documentId!==current.documentId)
      throw Error('MUTATION_OPERATION_DOCUMENT_IDENTITY_MISMATCH');
    const event=await makeEvent(previous,phase,metadata,this.now,current.identityHash);
    const updated={...current,updatedAt:Math.max(current.updatedAt,event.at),events:[...current.events,event]};
    try { await storage.set({[keyFor(id)]:updated}); }
    catch { throw Error('MUTATION_OPERATION_JOURNAL_WRITE_FAILED'); }
    return updated;
  }
  async #append(id,phase,metadata={}) {
    if (!validId(id)) throw Error('MUTATION_OPERATION_ID_INVALID');
    return enqueue(this.api,async()=>{
      const storage=await this.#storage();
      return this.#appendUnlocked(storage,id,phase,metadata);
    });
  }
  async begin({
    command,tabId,origin,url,documentId,frameId=0,conversationId=null,
    requestId=null,taskId=null,providerId=null,preparedId=null,payloadHash=null,epoch=null
  }={}) {
    if (!COMMANDS.has(command) || !Number.isSafeInteger(tabId) || tabId<=0 ||
        !validHttpsOrigin(origin) ||
        typeof url!=='string' || !url.startsWith(origin+'/') ||
        typeof documentId!=='string' || !documentId || documentId.length>200 ||
        !Number.isSafeInteger(frameId) || frameId!==0)
      throw Error('MUTATION_OPERATION_IDENTITY_INVALID');
    const operationId=this.uuid();
    if (!validId(operationId)) throw Error('MUTATION_OPERATION_ID_INVALID');
    const createdAt=this.now();
    const identity={
      schemaVersion:1,operationId,command,tabId,origin,urlSha256:await sha256(url),
      documentId:documentId.slice(0,200),frameId,
      conversationId:typeof conversationId==='string' ? conversationId.slice(0,160) : null,
      requestId:typeof requestId==='string' ? requestId.slice(0,100) : null,
      taskId:typeof taskId==='string' ? taskId.slice(0,100) : null,
      providerId:typeof providerId==='string' ? providerId.slice(0,40) : null,
      preparedId:typeof preparedId==='string' ? preparedId.slice(0,100) : null,
      payloadHash:typeof payloadHash==='string' && /^[a-f0-9]{64}$/.test(payloadHash) ? payloadHash : null,
      epoch:Number.isSafeInteger(epoch) && epoch>0 ? epoch : null,
      createdAt,updatedAt:createdAt
    };
    return enqueue(this.api,async()=>{
      const storage=await this.#storage();
      let all;
      try { all=await storage.get(null); }
      catch { throw Error('MUTATION_OPERATION_JOURNAL_UNAVAILABLE'); }
      const recordRows=Object.fromEntries(Object.entries(all||{}).filter(([name])=>
        name.startsWith(PREFIX) && name!==INDEX_KEY));
      const existing=Object.keys(recordRows);
      if (existing.length>=MAX_RECORDS) throw Error('MUTATION_OPERATION_JOURNAL_CAPACITY_EXCEEDED');
      const key=keyFor(operationId);
      if (Object.hasOwn(recordRows,key)) throw Error('MUTATION_OPERATION_ID_COLLISION');
      let index;
      try { index=await verifyIndex(all?.[INDEX_KEY]||null,recordRows); }
      catch { throw Error('MUTATION_OPERATION_JOURNAL_CORRUPT'); }
      const identityHash=await sha256(identityBody(identity));
      const event=await makeEvent(null,'ACCEPTED',{},this.now,identityHash);
      const record={...identity,updatedAt:Math.max(identity.createdAt,event.at),identityHash,events:[event]};
      const nextIndex=await appendIndex(index,operationId,identityHash);
      try { await storage.set({[key]:record,[INDEX_KEY]:nextIndex}); }
      catch { throw Error('MUTATION_OPERATION_JOURNAL_WRITE_FAILED'); }
      return record;
    });
  }
  async markInjecting(operationId,{documentId,frameId=0}={}) {
    if (typeof documentId!=='string' || !documentId || documentId.length>200 || frameId!==0)
      throw Error('MUTATION_OPERATION_DOCUMENT_IDENTITY_INVALID');
    return this.#append(operationId,'INJECTING',{documentId,frameId});
  }
  async complete(operationId,{outcome='COMPLETED',sideEffect='none',code=null,documentId=null,frameId=0}={}) {
    return this.#append(operationId,'COMPLETED',{outcome,sideEffect,code,documentId,frameId});
  }
  async abortBeforeInjection(operationId,{code='MUTATION_ABORTED_BEFORE_INJECTION',sideEffect='none'}={}) {
    return this.#append(operationId,'ABORTED_BEFORE_INJECTION',{outcome:'NOT_PERFORMED',code,sideEffect});
  }
  async unknown(operationId,{code='MUTATION_EXECUTION_UNKNOWN',sideEffect='operation-result-unverified'}={}) {
    return this.#append(operationId,'UNKNOWN',{outcome:'UNKNOWN',code,sideEffect});
  }
  async recover() {
    const snapshot=await enqueue(this.api,async()=>{
      const storage=await this.#storage();
      let all;
      try { all=await storage.get(null); }
      catch { throw Error('MUTATION_OPERATION_JOURNAL_UNAVAILABLE'); }
      const recordRows=Object.fromEntries(Object.entries(all||{}).filter(([key])=>
        key.startsWith(PREFIX) && key!==INDEX_KEY));
      const keys=Object.keys(recordRows);
      if (keys.length>MAX_RECORDS) throw Error('MUTATION_OPERATION_JOURNAL_CAPACITY_EXCEEDED');
      const records=[];
      try {
        const index=await verifyIndex(all?.[INDEX_KEY]||null,recordRows);
        for (const event of index.events) records.push(recordRows[keyFor(event.operationId)]);
      } catch { return {corrupt:true,records:[]}; }
      return {corrupt:false,records};
    });
    if (snapshot.corrupt) return {corrupt:true,quarantinedTabs:[],unresolved:[]};
    const quarantined=new Set(), unresolved=[];
    for (const record of snapshot.records) {
      const terminal=record.events.at(-1);
      const phase=terminal.phase;
      if (phase==='ACCEPTED') {
        await this.abortBeforeInjection(record.operationId,{
          code:'WORKER_RESTART_BEFORE_INJECTION',sideEffect:'none'
        });
      } else if (phase==='INJECTING' || phase==='UNKNOWN' ||
          (phase==='COMPLETED' && terminal.sideEffect==='composer-draft-state-unverified') ||
          (phase==='COMPLETED' && ['browser_click','browser_fill'].includes(record.command) &&
            terminal.sideEffect==='generic-page-action')) {
        if (phase==='INJECTING') {
          await this.unknown(record.operationId,{
            code:'WORKER_RESTART_DURING_INJECTION',sideEffect:'operation-result-unverified'
          });
        }
        quarantined.add(record.tabId);
        unresolved.push({
          operationId:record.operationId,command:record.command,
          tabId:record.tabId,origin:record.origin,
          documentId:record.documentId,
          phase:phase==='COMPLETED' && terminal.sideEffect==='composer-draft-state-unverified'
            ? 'DRAFT_UNVERIFIED'
            : phase==='COMPLETED'?'SIDE_EFFECT_UNVERIFIED':'UNKNOWN',
          reasonCode:phase==='INJECTING'?'WORKER_RESTART_DURING_INJECTION':
            terminal.code || (phase==='COMPLETED' && terminal.sideEffect==='composer-draft-state-unverified'
              ? 'COMPOSER_DRAFT_STATE_UNVERIFIED' : 'GENERIC_PAGE_SIDE_EFFECT_UNVERIFIED')
        });
      }
    }
    return {corrupt:false,quarantinedTabs:[...quarantined],unresolved};
  }
  async list() {
    const snapshot=await enqueue(this.api,async()=>{
      const storage=await this.#storage();
      let all;
      try { all=await storage.get(null); }
      catch { throw Error('MUTATION_OPERATION_JOURNAL_UNAVAILABLE'); }
      const recordRows=Object.fromEntries(Object.entries(all||{}).filter(([key])=>
        key.startsWith(PREFIX) && key!==INDEX_KEY));
      const keys=Object.keys(recordRows);
      if (keys.length>MAX_RECORDS) throw Error('MUTATION_OPERATION_JOURNAL_CAPACITY_EXCEEDED');
      const index=await verifyIndex(all?.[INDEX_KEY]||null,recordRows);
      return index.events.map(event=>recordRows[keyFor(event.operationId)]);
    });
    return snapshot;
  }
}
