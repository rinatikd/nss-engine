import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createProviderTransportV1, PROVIDER_TRANSPORT_API_VERSION } from '../consilium/provider-transport.mjs';

const binding={tabId:42,conversationId:'conversation_001',epoch:7};
const requestId='request_0001';
const contentText='Review the immutable source packet.';
const contentSha256=crypto.createHash('sha256').update(contentText,'utf8').digest('hex');
function prepared(overrides={}) {
  return {apiVersion:PROVIDER_TRANSPORT_API_VERSION,status:'PREPARED',requestId,binding,prepareId:'prepare_0001',fencingToken:'fencing-token-0123456789abcdef',expiresAt:'2026-11-22T20:00:00.000Z',...overrides};
}
function adapter(overrides={}) {
  return {
    apiVersion:PROVIDER_TRANSPORT_API_VERSION,
    async prepare(){return prepared()},
    async commit(){return {apiVersion:PROVIDER_TRANSPORT_API_VERSION,status:'SENT',requestId,binding,deliveryId:'delivery_0001'}},
    async query(){return {apiVersion:PROVIDER_TRANSPORT_API_VERSION,status:'UNKNOWN',requestId,binding,quarantineId:'quarantine_0001'}},
    async revoke(){return {apiVersion:PROVIDER_TRANSPORT_API_VERSION,binding,revoked:true,nextEpoch:binding.epoch+1}},
    ...overrides
  };
}

test('versioned transport requires prepare, commit, query and revoke',()=>{
  assert.throws(()=>createProviderTransportV1({apiVersion:'2.0'}),/TRANSPORT_API_VERSION_MISMATCH/);
  assert.throws(()=>createProviderTransportV1({apiVersion:PROVIDER_TRANSPORT_API_VERSION}),/TRANSPORT_METHOD_MISSING_PREPARE/);
});

test('prepare validates provider, content hash and exact tab/conversation/epoch binding',async()=>{
  let captured;
  const transport=createProviderTransportV1(adapter({async prepare(request){captured=request;return prepared()}}));
  const result=await transport.prepare({requestId,provider:'claude',binding,content:contentText,contentSha256});
  assert.equal(result.status,'PREPARED');
  assert.equal(captured.binding.epoch,7);
  assert.equal(captured.content,contentText);
  await assert.rejects(()=>transport.prepare({requestId,provider:'claude',binding,content:contentText,contentSha256:'0'.repeat(64)}),/TRANSPORT_CONTENT_HASH_MISMATCH/);
  await assert.rejects(()=>transport.prepare({requestId,provider:'unknown',binding,content:contentText,contentSha256}),/UNSUPPORTED_PROVIDER/);
});

test('commit requires prepare ID and fencing token and returns correlated delivery evidence',async()=>{
  let captured;
  const transport=createProviderTransportV1(adapter({async commit(request){captured=request;return {apiVersion:PROVIDER_TRANSPORT_API_VERSION,status:'SENT',requestId,binding,deliveryId:'delivery_0001'}}}));
  const result=await transport.commit({requestId,binding,prepareId:'prepare_0001',fencingToken:'fencing-token-0123456789abcdef'});
  assert.equal(captured.fencingToken,'fencing-token-0123456789abcdef');
  assert.equal(result.deliveryId,'delivery_0001');
  await assert.rejects(()=>transport.commit({requestId,binding,prepareId:'prepare_0001'}),/FENCING_TOKEN_REQUIRED/);
});

test('UNKNOWN is returned as quarantine and is never retried automatically',async()=>{
  let prepareCalls=0;
  const transport=createProviderTransportV1(adapter({async prepare(){prepareCalls++;return {apiVersion:PROVIDER_TRANSPORT_API_VERSION,status:'UNKNOWN',requestId,binding,quarantineId:'quarantine_0001'}}}));
  const result=await transport.prepare({requestId,provider:'chatgpt',binding,content:contentText,contentSha256});
  assert.equal(result.status,'UNKNOWN');
  assert.equal(result.quarantineId,'quarantine_0001');
  assert.equal(prepareCalls,1);
});

test('transport rejects stale bindings and uncorrelated adapter results',async()=>{
  const stale={...binding,epoch:6};
  const transport=createProviderTransportV1(adapter({async prepare(){return prepared({binding:stale})}}));
  await assert.rejects(()=>transport.prepare({requestId,provider:'chatgpt',binding,content:contentText,contentSha256}),/TRANSPORT_BINDING_MISMATCH/);
  const wrongRequest=createProviderTransportV1(adapter({async query(){return {apiVersion:PROVIDER_TRANSPORT_API_VERSION,status:'UNKNOWN',requestId:'request_other',binding,quarantineId:'quarantine_0001'}}}));
  await assert.rejects(()=>wrongRequest.query({requestId,binding,quarantineId:'quarantine_0001'}),/TRANSPORT_CORRELATION_MISMATCH/);
});

test('query preserves UNKNOWN quarantine and revoke requires a strictly newer epoch',async()=>{
  const transport=createProviderTransportV1(adapter());
  const state=await transport.query({requestId,binding,quarantineId:'quarantine_0001'});
  assert.equal(state.status,'UNKNOWN');
  assert.equal(state.quarantineId,'quarantine_0001');
  const revoked=await transport.revoke({binding,reason:'conversation changed'});
  assert.equal(revoked.revoked,true);
  assert.equal(revoked.nextEpoch,8);
  const invalid=createProviderTransportV1(adapter({async revoke(){return {apiVersion:PROVIDER_TRANSPORT_API_VERSION,binding,revoked:true,nextEpoch:7}}}));
  await assert.rejects(()=>invalid.revoke({binding,reason:'stop'}),/INVALID_REVOKE_ATTESTATION/);
});
