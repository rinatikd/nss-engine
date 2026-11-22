import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ProviderTransport, PROVIDER_TRANSPORT_V1, TransportContractError, validateTransportIdentity } from '../consilium/provider-transport-v1.mjs';

const identity={
  requestId:'request_0001',
  taskId:'task_000001',
  providerId:'claude',
  tabId:42,
  origin:'https://claude.ai',
  conversationId:'conversation_001',
  epoch:7
};
const message='Review the immutable source packet.';
const payloadHash=crypto.createHash('sha256').update(message,'utf8').digest('hex');
const expiresAt=()=>new Date(Date.now()+60_000).toISOString();
function baseAdapter(overrides={}) {
  return {
    version:PROVIDER_TRANSPORT_V1,
    async prepare(){return {state:'PREPARED',identity,preparedId:'prepared_001',fencingToken:'fencing-token-0123456789abcdef',expiresAt:expiresAt(),sideEffect:'composer-filled-no-send',clickedSend:false}},
    async commit(){return {state:'SENT',identity,clickedAt:new Date().toISOString(),clickedSend:true}},
    async status(){return {state:'UNKNOWN',identity,quarantineId:'quarantine_001'}},
    async stop(){return {state:'STOP_REQUESTED',identity}},
    async revoke(){return {state:'REVOKED',identity,nextEpoch:8}},
    async events(){return [{seq:1,eventId:'event_0001',requestId:identity.requestId,state:'UNKNOWN',providerId:'claude'}]},
    ...overrides
  };
}
function transport(adapter=baseAdapter(),verifyQuiescence=async()=>true) {
  return new ProviderTransport(adapter,{verifyQuiescence});
}

test('v1 requires the versioned prepare/commit/status/stop/revoke/events adapter surface',()=>{
  assert.throws(()=>new ProviderTransport({version:'v2'}),e=>e instanceof TransportContractError&&e.code==='TRANSPORT_VERSION_UNSUPPORTED');
  assert.throws(()=>new ProviderTransport({version:PROVIDER_TRANSPORT_V1}),e=>e.code==='TRANSPORT_METHOD_MISSING_PREPARE');
});

test('transport identity binds provider origin, tab, conversation and epoch',()=>{
  assert.deepEqual(validateTransportIdentity(identity),identity);
  assert.throws(()=>validateTransportIdentity({...identity,origin:'https://evil.example'}),e=>e.code==='ORIGIN_PROVIDER_MISMATCH');
  assert.throws(()=>validateTransportIdentity({...identity,epoch:0}),e=>e.code==='FENCING_EPOCH_INVALID');
  assert.throws(()=>validateTransportIdentity({...identity,conversationId:'bad space'}),e=>e.code==='CONVERSATION_ID_INVALID');
});

test('prepare validates payload hash, fencing token, expiry and no-send side effect',async()=>{
  const t=transport();
  const result=await t.prepare({...identity,message,payloadHash});
  assert.equal(result.state,'PREPARED');
  await assert.rejects(()=>t.prepare({...identity,message,payloadHash:'0'.repeat(64)}),e=>e.code==='PAYLOAD_HASH_MISMATCH');
  const clicked=transport(baseAdapter({async prepare(){return {state:'PREPARED',identity,preparedId:'prepared_001',fencingToken:'fencing-token-0123456789abcdef',expiresAt:expiresAt(),sideEffect:'composer-filled-no-send',clickedSend:true}}}));
  await assert.rejects(()=>clicked.prepare({...identity,message,payloadHash}),e=>e.code==='PREPARE_MUST_NOT_CLICK_SEND');
  const expired=transport(baseAdapter({async prepare(){return {state:'PREPARED',identity,preparedId:'prepared_001',fencingToken:'fencing-token-0123456789abcdef',expiresAt:'2000-01-01T00:00:00.000Z',sideEffect:'composer-filled-no-send',clickedSend:false}}}));
  await assert.rejects(()=>expired.prepare({...identity,message,payloadHash}),e=>e.code==='PREPARE_EXPIRY_INVALID');
});

test('commit requires fencing proof and explicit click evidence for SENT',async()=>{
  const t=transport();
  const result=await t.commit({...identity,preparedId:'prepared_001',fencingToken:'fencing-token-0123456789abcdef'});
  assert.equal(result.state,'SENT');
  const noClick=transport(baseAdapter({async commit(){return {state:'SENT',identity,clickedSend:false}}}));
  await assert.rejects(()=>noClick.commit({...identity,preparedId:'prepared_001',fencingToken:'fencing-token-0123456789abcdef'}),e=>e.code==='COMMIT_CLICK_EVIDENCE_REQUIRED');
});

test('UNKNOWN states require quarantine identity and are never auto-retried',async()=>{
  let calls=0;
  const t=transport(baseAdapter({async prepare(){calls++;return {state:'UNKNOWN',identity,quarantineId:'quarantine_001'}}}));
  const result=await t.prepare({...identity,message,payloadHash});
  assert.equal(result.state,'UNKNOWN');
  assert.equal(result.quarantineId,'quarantine_001');
  assert.equal(calls,1);
  const malformed=transport(baseAdapter({async status(){return {state:'UNKNOWN',identity}}}));
  await assert.rejects(()=>malformed.status(identity),e=>e.code==='UNKNOWN_QUARANTINE_ID_REQUIRED');
});

test('status and events preserve correlation and reject malformed event sequences',async()=>{
  const t=transport();
  assert.equal((await t.status(identity)).state,'UNKNOWN');
  assert.equal((await t.events({after:0,limit:10}))[0].seq,1);
  const bad=transport(baseAdapter({async events(){return [{seq:2,eventId:'event_0001',requestId:identity.requestId,state:'SENT',providerId:'claude'},{seq:1,eventId:'event_0002',requestId:identity.requestId,state:'SENT',providerId:'claude'}]}}));
  await assert.rejects(()=>bad.events(),e=>e.code==='TRANSPORT_EVENT_INVALID');
});

test('STOPPED_CLEAN requires independently verified epoch-bound quiescence',async()=>{
  const proof={verified:true,signatureValid:true,epoch:7,unresolved:0,outstandingPrepared:0,attestationId:'attest_0001',signature:'s'.repeat(64)};
  const t=transport(baseAdapter({async stop(){return {state:'STOPPED_CLEAN',identity,quiescence:proof}}}),async()=>true);
  assert.equal((await t.stop(identity)).state,'STOPPED_CLEAN');
  const unverified=transport(baseAdapter({async stop(){return {state:'STOPPED_CLEAN',identity,quiescence:proof}}}),async()=>false);
  await assert.rejects(()=>unverified.stop(identity),e=>e.code==='STOP_QUIESCENCE_ATTESTATION_INVALID');
});

test('revoke must attest a strictly newer epoch for the exact binding',async()=>{
  const t=transport();
  assert.equal((await t.revoke(identity)).nextEpoch,8);
  const invalid=transport(baseAdapter({async revoke(){return {state:'REVOKED',identity,nextEpoch:7}}}));
  await assert.rejects(()=>invalid.revoke(identity),e=>e.code==='FENCING_REVOKE_ATTESTATION_INVALID');
});
