import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { signQuiescence } from './provider-transport-crypto.mjs';

const ID=/^[A-Za-z0-9_-]{8,100}$/;
const CONVERSATION_ID=/^[A-Za-z0-9_-]{8,160}$/;
const PROVIDERS={
  'https://claude.ai':'claude',
  'https://gemini.google.com':'gemini',
  'https://chat.deepseek.com':'deepseek',
  'https://grok.com':'grok',
  'https://chat.qwen.ai':'qwen',
  'https://www.kimi.ai':'kimi'
};
const STATES=new Set(['PREPARING','PREPARED','COMMITTING','SENT','UNKNOWN','NOT_PERFORMED','BLOCKED','REVOKED','STOP_REQUESTED','STOPPED_CLEAN','STOP_AFTER_COMMIT']);
const MAX_BYTES=16*1024*1024;
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));

export function validateProviderIdentity(input) {
  if(!input||typeof input!=='object')throw Error('PROVIDER_IDENTITY_REQUIRED');
  if(!ID.test(input.requestId||'')||!ID.test(input.taskId||''))throw Error('PROVIDER_REQUEST_ID_INVALID');
  if(PROVIDERS[input.origin]!==input.providerId)throw Error('PROVIDER_ORIGIN_MISMATCH');
  if(!Number.isSafeInteger(input.tabId)||input.tabId<=0)throw Error('PROVIDER_TAB_ID_INVALID');
  if(typeof input.conversationId!=='string'||!CONVERSATION_ID.test(input.conversationId))throw Error('PROVIDER_CONVERSATION_INVALID');
  if(!Number.isSafeInteger(input.epoch)||input.epoch<1)throw Error('PROVIDER_EPOCH_INVALID');
  return Object.freeze({
    requestId:input.requestId,taskId:input.taskId,providerId:input.providerId,
    tabId:input.tabId,origin:input.origin,conversationId:input.conversationId,epoch:input.epoch
  });
}

function identityEqual(a,b) {
  return !!a&&!!b&&a.requestId===b.requestId&&a.taskId===b.taskId&&
    a.providerId===b.providerId&&a.tabId===b.tabId&&a.origin===b.origin&&
    a.conversationId===b.conversationId&&a.epoch===b.epoch;
}
function hash(key,value) {
  return crypto.createHmac('sha256',key).update(value,'utf8').digest('hex');
}
function tokenHash(token) { return crypto.createHash('sha256').update(token,'utf8').digest('hex'); }

export class ProviderJournal {
  constructor(stateDir,{hmacKey,bridgeEpoch=crypto.randomUUID(),fsOps=fs,now=Date.now,maxBytes=MAX_BYTES}={}) {
    if(typeof stateDir!=='string'||!path.isAbsolute(stateDir))throw Error('PROVIDER_JOURNAL_DIR_REQUIRED');
    if(!Buffer.isBuffer(hmacKey)||hmacKey.length<32)throw Error('PROVIDER_JOURNAL_KEY_REQUIRED');
    if(!ID.test(bridgeEpoch))throw Error('PROVIDER_BRIDGE_EPOCH_INVALID');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>64*1024*1024)throw Error('PROVIDER_JOURNAL_SIZE_INVALID');
    this.fs=fsOps;this.now=now;this.key=Buffer.from(hmacKey);this.bridgeEpoch=bridgeEpoch;this.maxBytes=maxBytes;
    this.fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
    this.file=path.join(stateDir,'provider-transactions.jsonl');
    this.lockFile=this.file+'.lock';
    this.records=[];this.transactions=new Map();this.tabEpochs=new Map();this.lastHash='0'.repeat(64);
    this.#load();
    // A restart invalidates every in-flight/prepared transaction. Never infer
    // that a prior browser click did not happen merely because its ACK is gone.
    for(const tx of this.transactions.values()) {
      if(['PREPARING','PREPARED','COMMITTING'].includes(tx.state)) {
        this.outcome(tx.identity,'UNKNOWN','BRIDGE_RESTART');
      }
    }
  }

  #recordHash(record) {
    const body={seq:record.seq,eventId:record.eventId,type:record.type,identity:record.identity,data:record.data,prevHash:record.prevHash};
    return hash(this.key,JSON.stringify(body));
  }

  #load() {
    let stat;
    try{stat=this.fs.lstatSync(this.file);}
    catch(error){if(error.code==='ENOENT')return;throw Error('PROVIDER_JOURNAL_READ_FAILED');}
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('PROVIDER_JOURNAL_CORRUPT_FAIL_CLOSED');
    if(stat.size>this.maxBytes)throw Error('PROVIDER_JOURNAL_TOO_LARGE_FAIL_CLOSED');
    let raw;
    try{raw=this.fs.readFileSync(this.file,'utf8');}catch{throw Error('PROVIDER_JOURNAL_READ_FAILED');}
    let expectedSeq=1,previous='0'.repeat(64);
    for(const line of raw.split('\n')) {
      if(!line)continue;
      let record;
      try{record=JSON.parse(line);}catch{throw Error('PROVIDER_JOURNAL_CORRUPT_FAIL_CLOSED');}
      if(record.seq!==expectedSeq||record.prevHash!==previous||!ID.test(record.eventId||'')||
        typeof record.type!=='string'||!record.data||typeof record.data!=='object'||
        !record.identity||!identityEqual(validateProviderIdentity(record.identity),record.identity)||
        record.hash!==this.#recordHash(record))throw Error('PROVIDER_JOURNAL_CORRUPT_FAIL_CLOSED');
      this.#apply(record);this.records.push(record);previous=record.hash;expectedSeq++;
    }
    this.lastHash=previous;
  }

  #apply(record) {
    const {type,identity,data}=record;
    if(type==='epoch.initialized')this.tabEpochs.set(identity.tabId,data.epoch);
    else if(type==='epoch.revoked')this.tabEpochs.set(identity.tabId,data.nextEpoch);
    else if(type==='prepare.started')this.transactions.set(identity.requestId,{
      identity:clone(identity),state:'PREPARING',payloadHash:data.payloadHash,bridgeEpoch:data.bridgeEpoch,
      createdAt:data.at
    });
    else if(type==='prepare.completed') {
      const old=this.transactions.get(identity.requestId)||{identity:clone(identity)};
      this.transactions.set(identity.requestId,{...old,state:'PREPARED',preparedId:data.preparedId,
        expiresAt:data.expiresAt,tokenHash:data.tokenHash,bridgeEpoch:data.bridgeEpoch,payloadHash:data.payloadHash});
    } else if(type==='commit.started') {
      const old=this.transactions.get(identity.requestId);
      if(old)this.transactions.set(identity.requestId,{...old,state:'COMMITTING'});
    } else if(type==='commit.completed') {
      const old=this.transactions.get(identity.requestId);
      if(old)this.transactions.set(identity.requestId,{...old,state:'SENT',clickedAt:data.clickedAt,clickedSend:true});
    } else if(type==='transaction.outcome') {
      const old=this.transactions.get(identity.requestId)||{identity:clone(identity)};
      this.transactions.set(identity.requestId,{...old,state:data.state,reasonCode:data.reasonCode||null,
        quarantineId:data.quarantineId||null,nextEpoch:data.nextEpoch||null});
    } else if(type==='stop.clean') {
      const old=this.transactions.get(identity.requestId)||{identity:clone(identity)};
      this.transactions.set(identity.requestId,{...old,state:'STOPPED_CLEAN',quiescence:clone(data.quiescence),nextEpoch:data.nextEpoch});
    } else if(type==='stop.requested') {
      const old=this.transactions.get(identity.requestId)||{identity:clone(identity)};
      this.transactions.set(identity.requestId,{...old,state:'STOP_REQUESTED',nextEpoch:data.nextEpoch||null});
    } else if(type==='stop.after_commit') {
      const old=this.transactions.get(identity.requestId)||{identity:clone(identity)};
      this.transactions.set(identity.requestId,{...old,state:'STOP_AFTER_COMMIT',nextEpoch:data.nextEpoch||null});
    }
  }

  #append(type,identity,data) {
    const lock=this.fs.openSync(this.lockFile,'wx',0o600);
    let fd;
    try {
      this.fs.writeFileSync(lock,JSON.stringify({pid:process.pid,at:new Date(this.now()).toISOString()}));
      this.fs.fsyncSync(lock);
      const record={
        seq:this.records.length+1,eventId:crypto.randomUUID(),type,
        identity:clone(identity),data:clone(data),prevHash:this.lastHash
      };
      record.hash=this.#recordHash(record);
      const line=JSON.stringify(record)+'\n';
      const current=this.fs.existsSync(this.file)?this.fs.statSync(this.file).size:0;
      if(current+Buffer.byteLength(line,'utf8')>this.maxBytes)throw Error('PROVIDER_JOURNAL_FULL_FAIL_CLOSED');
      fd=this.fs.openSync(this.file,'a',0o600);
      this.fs.writeFileSync(fd,line,'utf8');this.fs.fsyncSync(fd);this.fs.closeSync(fd);fd=undefined;
      this.#apply(record);this.records.push(record);this.lastHash=record.hash;
      return clone(record);
    } finally {
      if(fd!==undefined)try{this.fs.closeSync(fd);}catch{}
      try{this.fs.closeSync(lock);}catch{}
      try{this.fs.unlinkSync(this.lockFile);}catch{}
    }
  }

  #ensureEpoch(identity) {
    const current=this.tabEpochs.get(identity.tabId);
    if(current===undefined) {
      this.#append('epoch.initialized',identity,{epoch:identity.epoch,at:new Date(this.now()).toISOString()});
      return;
    }
    if(current!==identity.epoch)throw Error('STALE_FENCING_EPOCH');
  }

  #fencingToken(tx) {
    return hash(this.key,JSON.stringify({
      purpose:'chrome-bridge/provider-fencing/v1',bridgeEpoch:tx.bridgeEpoch,
      identity:tx.identity,preparedId:tx.preparedId,payloadHash:tx.payloadHash,expiresAt:tx.expiresAt
    }));
  }

  beginPrepare(input,payloadHash) {
    const identity=validateProviderIdentity(input);
    if(typeof payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(payloadHash))throw Error('PROVIDER_PAYLOAD_HASH_INVALID');
    const old=this.transactions.get(identity.requestId);
    if(old) {
      if(!identityEqual(old.identity,identity)||old.payloadHash!==payloadHash)throw Error('PROVIDER_REQUEST_ID_CONFLICT');
      if(old.state==='PREPARED'&&old.bridgeEpoch===this.bridgeEpoch&&Date.parse(old.expiresAt)>this.now()&&
         this.tabEpochs.get(identity.tabId)===identity.epoch) {
        return {duplicate:true,transaction:this.status(identity),fencingToken:this.#fencingToken(old)};
      }
      if(['PREPARING','COMMITTING','UNKNOWN','SENT','REVOKED','STOPPED_CLEAN',
          'NOT_PERFORMED','BLOCKED','STOP_REQUESTED','STOP_AFTER_COMMIT'].includes(old.state)) {
        return {duplicate:true,transaction:this.status(identity)};
      }
      throw Error('PROVIDER_REQUEST_IN_PROGRESS');
    }
    this.#ensureEpoch(identity);
    for(const existing of this.transactions.values()) {
      if(existing.identity.tabId===identity.tabId&&
         ['PREPARING','PREPARED','COMMITTING','UNKNOWN','STOP_REQUESTED'].includes(existing.state)) {
        throw Error('PROVIDER_TAB_QUARANTINED');
      }
    }
    this.#append('prepare.started',identity,{payloadHash,bridgeEpoch:this.bridgeEpoch,at:new Date(this.now()).toISOString()});
    return {duplicate:false};
  }

  completePrepare(input,{preparedId,expiresAt}) {
    const identity=validateProviderIdentity(input);
    const tx=this.transactions.get(identity.requestId);
    if(!tx||tx.state!=='PREPARING'||!identityEqual(tx.identity,identity))throw Error('PROVIDER_PREPARE_STATE_INVALID');
    if(typeof preparedId!=='string'||!ID.test(preparedId)||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=this.now())throw Error('PROVIDER_PREPARE_RECEIPT_INVALID');
    const token=this.#fencingToken({...tx,preparedId,expiresAt});
    this.#append('prepare.completed',identity,{preparedId,expiresAt,payloadHash:tx.payloadHash,
      bridgeEpoch:this.bridgeEpoch,tokenHash:tokenHash(token)});
    return {state:'PREPARED',identity,requestId:identity.requestId,payloadHash:tx.payloadHash,preparedId,expiresAt,fencingToken:token,
      sideEffect:'composer-filled-no-send',clickedSend:false};
  }

  beginCommit(input,{preparedId,fencingToken,payloadHash}) {
    const identity=validateProviderIdentity(input);
    this.#ensureEpoch(identity);
    const tx=this.transactions.get(identity.requestId);
    if(!tx||!identityEqual(tx.identity,identity)||tx.state!=='PREPARED')throw Error('PROVIDER_PREPARE_NOT_COMMITTABLE');
    if(tx.bridgeEpoch!==this.bridgeEpoch||Date.parse(tx.expiresAt)<=this.now())throw Error('PROVIDER_PREPARE_EXPIRED_OR_RESTARTED');
    if(tx.preparedId!==preparedId)throw Error('PROVIDER_PREPARED_ID_MISMATCH');
    if(payloadHash!==tx.payloadHash)throw Error('PROVIDER_PAYLOAD_HASH_MISMATCH');
    const expectedToken=this.#fencingToken(tx);
    if(tx.tokenHash!==tokenHash(expectedToken))throw Error('PROVIDER_JOURNAL_TOKEN_CORRUPT');
    const expected=Buffer.from(expectedToken,'hex');
    const supplied=Buffer.from(typeof fencingToken==='string'?fencingToken:'','hex');
    if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))throw Error('PROVIDER_FENCING_TOKEN_INVALID');
    this.#append('commit.started',identity,{preparedId,bridgeEpoch:this.bridgeEpoch,at:new Date(this.now()).toISOString()});
    return clone(tx);
  }

  completeCommit(input,{clickedAt,clickedSend}) {
    const identity=validateProviderIdentity(input);
    const tx=this.transactions.get(identity.requestId);
    if(!tx||tx.state!=='COMMITTING'||!identityEqual(tx.identity,identity)||
      clickedSend!==true||!Number.isFinite(Date.parse(clickedAt||'')))throw Error('PROVIDER_COMMIT_RECEIPT_INVALID');
    this.#append('commit.completed',identity,{clickedAt,clickedSend:true});
    return {state:'SENT',identity,requestId:identity.requestId,preparedId:tx.preparedId,payloadHash:tx.payloadHash,clickedAt,clickedSend:true};
  }

  outcome(input,state,reasonCode='',extra={}) {
    const identity=validateProviderIdentity(input);
    if(!['UNKNOWN','NOT_PERFORMED','BLOCKED','REVOKED','STOP_AFTER_COMMIT'].includes(state))throw Error('PROVIDER_OUTCOME_STATE_INVALID');
    const quarantineId=state==='UNKNOWN'?'quarantine-'+identity.requestId:null;
    this.#append('transaction.outcome',identity,{state,reasonCode:/^[A-Z][A-Z0-9_]{2,80}$/.test(reasonCode)?reasonCode:'',quarantineId,...extra});
    return {state,identity,...(quarantineId?{quarantineId}:{}),...(reasonCode?{reasonCode}:{})};
  }

  status(input) {
    const identity=validateProviderIdentity(input);
    const tx=this.transactions.get(identity.requestId);
    if(!tx)return {state:'NOT_PERFORMED',identity,reasonCode:'REQUEST_NOT_FOUND'};
    if(!identityEqual(tx.identity,identity))throw Error('PROVIDER_REQUEST_ID_CONFLICT');
    const publicState=tx.state==='PREPARING'?'ACCEPTED':tx.state==='COMMITTING'?'DISPATCHED':tx.state;
    const out={state:publicState,identity,...(tx.reasonCode?{reasonCode:tx.reasonCode}:{}),
      ...(tx.quarantineId?{quarantineId:tx.quarantineId}:{}),
      ...(tx.preparedId?{preparedId:tx.preparedId,expiresAt:tx.expiresAt}:{}),
      ...(tx.state==='PREPARED'?{requestId:identity.requestId,fencingToken:this.#fencingToken(tx),payloadHash:tx.payloadHash,sideEffect:'composer-filled-no-send',clickedSend:false}:{}),
      ...(tx.clickedAt?{requestId:identity.requestId,preparedId:tx.preparedId,payloadHash:tx.payloadHash,clickedAt:tx.clickedAt,clickedSend:true}:{}),
      ...(tx.nextEpoch?{nextEpoch:tx.nextEpoch}:{})};
    return out;
  }

  #revokeEpoch(identity) {
    const nextEpoch=identity.epoch+1;
    this.#append('epoch.revoked',identity,{previousEpoch:identity.epoch,nextEpoch});
    for(const tx of [...this.transactions.values()]) {
      if(tx.identity.tabId!==identity.tabId)continue;
      if(tx.state==='PREPARED') {
        this.outcome(tx.identity,'REVOKED','FENCING_EPOCH_REVOKED',{nextEpoch});
      } else if(['PREPARING','COMMITTING','UNKNOWN','STOP_REQUESTED'].includes(tx.state)) {
        this.outcome(tx.identity,'UNKNOWN','FENCING_EPOCH_REVOKED_DURING_UNCERTAIN_ACTION',{nextEpoch});
      }
    }
    return nextEpoch;
  }

  revoke(input) {
    const identity=validateProviderIdentity(input);
    const tx=this.transactions.get(identity.requestId);
    if(tx&&!identityEqual(tx.identity,identity))throw Error('PROVIDER_REQUEST_ID_CONFLICT');
    if(tx&&['REVOKED','STOPPED_CLEAN','STOP_AFTER_COMMIT'].includes(tx.state))
      return {state:'REVOKED',identity,nextEpoch:tx.nextEpoch};
    if(tx&&['UNKNOWN','STOP_REQUESTED'].includes(tx.state)&&tx.nextEpoch)
      return {state:'UNKNOWN',identity,quarantineId:tx.quarantineId,nextEpoch:tx.nextEpoch};
    this.#ensureEpoch(identity);
    const nextEpoch=this.#revokeEpoch(identity);
    const updated=this.transactions.get(identity.requestId);
    if(updated&&updated.state==='UNKNOWN') {
      return {state:'UNKNOWN',identity,quarantineId:updated.quarantineId,nextEpoch};
    }
    if(updated&&updated.state==='REVOKED')return {state:'REVOKED',identity,nextEpoch};
    this.outcome(identity,'REVOKED','FENCING_EPOCH_REVOKED',{nextEpoch});
    return {state:'REVOKED',identity,nextEpoch};
  }

  stop(input) {
    const identity=validateProviderIdentity(input);
    const tx=this.transactions.get(identity.requestId);
    if(tx&&!identityEqual(tx.identity,identity))throw Error('PROVIDER_REQUEST_ID_CONFLICT');
    if(tx&&['STOPPED_CLEAN','STOP_REQUESTED','STOP_AFTER_COMMIT'].includes(tx.state)) {
      return {state:tx.state,identity,nextEpoch:tx.nextEpoch,...(tx.quiescence?{quiescence:clone(tx.quiescence)}:{})};
    }
    this.#ensureEpoch(identity);
    if(tx&&tx.state==='SENT') {
      const nextEpoch=this.#revokeEpoch(identity);
      this.#append('stop.after_commit',identity,{nextEpoch});
      return {state:'STOP_AFTER_COMMIT',identity,nextEpoch};
    }
    if(tx&&['COMMITTING','UNKNOWN','PREPARING'].includes(tx.state)) {
      const nextEpoch=this.#revokeEpoch(identity);
      this.#append('stop.requested',identity,{reason:'IN_FLIGHT_OR_AMBIGUOUS',nextEpoch});
      return {state:'STOP_REQUESTED',identity,nextEpoch};
    }
    const nextEpoch=this.#revokeEpoch(identity);
    const proof={
      verified:true,signatureValid:true,epoch:identity.epoch,nextEpoch,
      unresolved:0,outstandingPrepared:0,attestationId:'attest_'+crypto.randomBytes(12).toString('hex'),signature:''
    };
    proof.signature=signQuiescence(proof,identity,this.key);
    this.#append('stop.clean',identity,{nextEpoch,quiescence:proof});
    return {state:'STOPPED_CLEAN',identity,nextEpoch,quiescence:proof};
  }

  events({after=0,limit=100}={}) {
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('PROVIDER_EVENT_WINDOW_INVALID');
    const stateFor=record=>({
      'epoch.initialized':'ACCEPTED','epoch.revoked':'REVOKED','prepare.started':'ACCEPTED',
      'prepare.completed':'PREPARED','commit.started':'DISPATCHED','commit.completed':'SENT',
      'transaction.outcome':record.data.state,'stop.requested':'STOP_REQUESTED','stop.clean':'STOPPED_CLEAN','stop.after_commit':'STOP_AFTER_COMMIT'
    })[record.type]||'UNKNOWN';
    return this.records.filter(e=>e.seq>after).slice(0,limit).map(e=>({
      seq:e.seq,eventId:e.eventId,requestId:e.identity.requestId,providerId:e.identity.providerId,
      state:stateFor(e),identity:clone(e.identity),
      ...(e.data.quarantineId?{quarantineId:e.data.quarantineId}:{})
    }));
  }
}
