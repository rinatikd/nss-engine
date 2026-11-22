import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  ChromeBridgeProviderAdapter,
  ChromeBridgeAdapterError,
  createQuiescenceVerifier
} from '../consilium/chrome-bridge-provider-adapter.mjs';
import { PROVIDER_TRANSPORT_V1 } from '../consilium/provider-transport-v1.mjs';

const token='a'.repeat(64);
const endpoint='http://127.0.0.1:17484';
const identity={
  requestId:'request_0001',taskId:'task_000001',providerId:'claude',
  tabId:42,origin:'https://claude.ai',conversationId:'conversation_001',epoch:7
};
function response(data,{status=200,isError=false,id='provider-provider_prepare-request_0001'}={}) {
  return {ok:status>=200&&status<300,status,json:async()=>({
    jsonrpc:'2.0',id,
    result:{isError,content:[{type:'text',text:isError?String(data):JSON.stringify(data)}]}
  })};
}
function adapter(fetchImpl) {
  return new ChromeBridgeProviderAdapter({endpoint,agentToken:token,fetchImpl,timeoutMs:1000});
}

test('adapter is versioned and accepts only a loopback MCP endpoint',()=>{
  assert.equal(adapter(async()=>response({})).version,PROVIDER_TRANSPORT_V1);
  for(const bad of ['https://127.0.0.1:17484','http://localhost:17484','http://192.168.1.4:17484','http://127.0.0.1:17484/other']) {
    assert.throws(()=>new ChromeBridgeProviderAdapter({endpoint:bad,agentToken:token}),e=>
      e instanceof ChromeBridgeAdapterError && ['BRIDGE_ENDPOINT_MUST_BE_LOOPBACK'].includes(e.code));
  }
  assert.throws(()=>new ChromeBridgeProviderAdapter({endpoint,agentToken:'short'}),/BRIDGE_AGENT_TOKEN_INVALID/);
});

test('prepare calls the Bridge MCP tool with exact identity and payload correlation',async()=>{
  let request;
  const a=adapter(async(url,init)=>{request={url,init,body:JSON.parse(init.body)};return response({
    state:'PREPARED',identity,preparedId:'prepared_001',fencingToken:'f'.repeat(40),
    expiresAt:new Date(Date.now()+60000).toISOString(),sideEffect:'composer-filled-no-send',clickedSend:false
  });});
  const result=await a.prepare({...identity,message:'Review this source.',payloadHash:'b'.repeat(64)});
  assert.equal(result.state,'PREPARED');
  assert.equal(request.url,endpoint+'/mcp');
  assert.equal(request.init.method,'POST');
  assert.equal(request.init.headers.Authorization,'Bearer '+token);
  assert.equal(request.body.params.name,'provider_prepare');
  assert.equal(request.body.params.arguments.requestId,identity.requestId);
  assert.equal(request.body.params.arguments.payloadHash,'b'.repeat(64));
  assert.equal(request.body.params.arguments.message,'Review this source.');
});

test('commit uses a distinct tool and preserves prepared ID plus fencing token',async()=>{
  let request;
  const a=adapter(async(url,init)=>{request=JSON.parse(init.body);return response({state:'SENT',identity,clickedAt:new Date().toISOString(),clickedSend:true},{id:'provider-provider_commit-request_0001'});});
  const result=await a.commit({...identity,preparedId:'prepared_001',fencingToken:'f'.repeat(40)});
  assert.equal(result.state,'SENT');
  assert.equal(request.params.name,'provider_commit');
  assert.equal(request.params.arguments.preparedId,'prepared_001');
  assert.equal(request.params.arguments.fencingToken,'f'.repeat(40));
});

test('ambiguous prepare acknowledgement is quarantined and never retried',async()=>{
  let calls=0;
  const a=adapter(async()=>{calls++;throw Error('socket closed after request body');});
  const result=await a.prepare({...identity,message:'x',payloadHash:'b'.repeat(64)});
  assert.equal(result.state,'UNKNOWN');
  assert.equal(result.quarantineId,'quarantine-'+identity.requestId);
  assert.equal(calls,1);
});

test('ambiguous commit acknowledgement is quarantined and never retried',async()=>{
  let calls=0;
  const a=adapter(async()=>{calls++;throw Object.assign(Error('timed out'),{name:'TimeoutError'});});
  const result=await a.commit({...identity,preparedId:'prepared_001',fencingToken:'f'.repeat(40)});
  assert.equal(result.state,'UNKNOWN');
  assert.equal(result.quarantineId,'quarantine-'+identity.requestId);
  assert.equal(calls,1);
});

test('definite authorization denial is BLOCKED, not UNKNOWN',async()=>{
  const a=adapter(async()=>response('Unauthorized',{status:401}));
  const result=await a.prepare({...identity,message:'x',payloadHash:'b'.repeat(64)});
  assert.equal(result.state,'BLOCKED');
  assert.equal(result.reasonCode,'BRIDGE_AUTH_ORIGIN_DENIED');
});

test('status is read-only and degrades to UNKNOWN when Bridge is unreachable',async()=>{
  let request;
  const a=adapter(async(url,init)=>{request=JSON.parse(init.body);return response({state:'PREPARED',identity,preparedId:'prepared_001'},{id:'provider-provider_status-request_0001'});});
  assert.equal((await a.status(identity)).state,'PREPARED');
  assert.equal(request.params.name,'provider_status');
  const down=adapter(async()=>{throw Error('offline');});
  const result=await down.status(identity);
  assert.equal(result.state,'UNKNOWN');
  assert.equal(result.quarantineId,'quarantine-'+identity.requestId);
});

test('quiescence verifier authenticates the exact epoch-bound proof',async()=>{
  const proof={
    epoch:7,nextEpoch:8,unresolved:0,outstandingPrepared:0,
    attestationId:'attest_0001',signature:''
  };
  const canonical=JSON.stringify({
    purpose:'chrome-bridge/provider-quiescence/v1',
    requestId:identity.requestId,taskId:identity.taskId,providerId:identity.providerId,
    tabId:identity.tabId,origin:identity.origin,conversationId:identity.conversationId,
    epoch:proof.epoch,nextEpoch:proof.nextEpoch,unresolved:proof.unresolved,
    outstandingPrepared:proof.outstandingPrepared,attestationId:proof.attestationId
  });
  const key=crypto.createHmac('sha256','chrome-bridge/provider-journal/v1').update(token,'utf8').digest();
  proof.signature=crypto.createHmac('sha256',key).update(canonical,'utf8').digest('hex');
  const verify=createQuiescenceVerifier(token);
  assert.equal(await verify(proof,identity),true);
  assert.equal(await verify({...proof,nextEpoch:9},identity),false);
  assert.equal(await verify(proof,{...identity,tabId:99}),false);
});
