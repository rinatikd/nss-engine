import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatchMutation} from '../extension/mutation-dispatch.js';

function fixture({
  changed=false,deny=false,expiredGrant=false,badOrigin=false,conversationChanged=false
}={}) {
  const state={injections:[],targets:[],approvalCount:0,allowAt:true,
    documentId:'document-main-0001',grant:Date.now()+120000};
  const url=badOrigin?'https://not-allowed.example/app':'https://claude.ai/chat/abcdefghi';
  const chromeApi={
    tabs:{get:async()=>({id:9,url:changed && !state.allowAt ?
      'https://claude.ai/chat/other12345':url,title:'Test'})},
    storage:{local:{get:async key=>key==='sites'?
      {sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}}}:{adapters:'{}'}}},
    permissions:{contains:async()=>true},
    scripting:{executeScript:async({args,target,world})=>{
      const [name,details]=args;
      state.injections.push(name);
      state.targets.push({target,world,name});
      const response=result=>[{
        documentId:target.documentIds?.[0]||state.documentId,frameId:0,result
      }];
      if(name==='describe')return response({
        tag:'button',text:'Send',href:'',formAction:'',type:'button'});
      if(name==='agent_context')return response({
        verified:true,origin:'https://claude.ai',
        conversationId:conversationChanged && !state.allowAt?'other':'abcdefghi'
      });
      return response({ok:true,sent:name==='agent_send'});
    }}
  };
  const approvals={request:async() => {
    state.approvalCount++;
    if(deny) throw Error('USER_DENIED');
    state.allowAt=false;
  }};
  const controlGrant=async()=>expiredGrant&& !state.allowAt ? Date.now()-1 :state.grant;
  return {chromeApi,approvals,controlGrant,state};
}
const cmd=(name='browser_click')=>({
  id:'cmd_1',name,expires:Date.now()+90000,
  args:{tabId:9,selector:'button.send',text:'Hello!',expectedOrigin:'https://claude.ai',
    expectedConversationId:'abcdefghi'}
});
const execute=(c,f)=>dispatchMutation(c,f.chromeApi,{
  approvals:f.approvals,controlGrant:f.controlGrant,stillEnabled:async()=>true,uuid:()=> 'fixedid'
});
test('click executes only after fresh site/target revalidation and approval',async()=>{
 const f=fixture();
 assert.deepEqual(await execute(cmd(),f),{ok:true,sent:false});
 assert.deepEqual(f.state.injections,['describe','describe','browser_click']);
 assert.equal(f.state.approvalCount,1);
});

test('every mutation injection is explicitly isolated and pinned after the first document capture',async()=>{
 const f=fixture();
 await execute(cmd('browser_click'),f);
 assert.deepEqual(f.state.targets.map(x=>x.name),['describe','describe','browser_click']);
 assert.deepEqual(f.state.targets[0].target,{tabId:9});
 for(const call of f.state.targets) assert.equal(call.world,'ISOLATED');
 for(const call of f.state.targets.slice(1))
   assert.deepEqual(call.target,{tabId:9,documentIds:[f.state.documentId]});

 const send=fixture();
 await execute(cmd('agent_send'),send);
 assert.deepEqual(send.state.targets.map(x=>x.target),[
   {tabId:9},
   {tabId:9,documentIds:[send.state.documentId]},
   {tabId:9,documentIds:[send.state.documentId]}
 ]);
 assert.ok(send.state.targets.every(x=>x.world==='ISOLATED'));
});

test('provider prepare and commit pin all post-preflight injections to the same document',async()=>{
 for(const name of ['provider_prepare','provider_commit']) {
   const f=providerFixture();
   await dispatchMutation(providerCommand(name),f.chromeApi,{
     approvals:f.approvals,controlGrant:f.controlGrant,stillEnabled:async()=>true,uuid:()=> 'doc-bound-provider'
   });
   assert.deepEqual(f.state.targets.map(x=>x.target),[
     {tabId:9},
     {tabId:9,documentIds:[f.state.documentId]},
     {tabId:9,documentIds:[f.state.documentId]}
   ],name);
   assert.ok(f.state.targets.every(x=>x.world==='ISOLATED'),name);
 }
});

test('stale exact-document injection fails closed and is never rebound to the active tab document',async()=>{
 const f=fixture();
 const original=f.chromeApi.scripting.executeScript;
 let mutationCalls=0;
 f.chromeApi.scripting.executeScript=async payload=>{
   if(payload.args[0]==='browser_click') {
     mutationCalls++;
     assert.deepEqual(payload.target,{tabId:9,documentIds:[f.state.documentId]});
     throw Error('No frame with given document id found');
   }
   return original(payload);
 };
 await assert.rejects(execute(cmd('browser_click'),f),error=>{
   assert.equal(error.message,'DOCUMENT_BOUND_INJECTION_FAILED');
   assert.equal(error.dispatchState,'UNKNOWN');
   return true;
 });
 assert.equal(mutationCalls,1);
 assert.equal(f.state.targets.some(x=>x.name==='browser_click'),false,
   'a rejected stale-document request must not be retried with a tab-only target');
});

test('document identity missing from initial injection blocks approval and mutation',async()=>{
 const f=fixture();
 const original=f.chromeApi.scripting.executeScript;
 f.chromeApi.scripting.executeScript=async payload=>{
   if(payload.args[0]==='describe') {
     return [{frameId:0,result:{tag:'button',text:'Send',href:'',formAction:'',type:'button'}}];
   }
   return original(payload);
 };
 await assert.rejects(execute(cmd('browser_click'),f),error=>{
   assert.equal(error.message,'INJECTION_DOCUMENT_IDENTITY_UNAVAILABLE');
   assert.equal(error.dispatchState,'NOT_PERFORMED');
   return true;
 });
 assert.equal(f.state.approvalCount,0);
 assert.equal(f.state.injections.includes('browser_click'),false);
});

test('tab navigation during initial document capture blocks before presenting approval',async()=>{
 const f=fixture();
 let reads=0;
 f.chromeApi.tabs.get=async id=>({
   id,url:++reads>=3?'https://claude.ai/chat/replaced_document_001':
     'https://claude.ai/chat/abcdefghi',title:'Test'
 });
 await assert.rejects(execute(cmd('browser_click'),f),/TAB_CHANGED_AFTER_APPROVAL/);
 assert.equal(f.state.approvalCount,0);
 assert.equal(f.state.injections.includes('browser_click'),false);
});

test('incomplete result identity after a document-targeted mutation remains UNKNOWN',async()=>{
 const f=fixture();
 const original=f.chromeApi.scripting.executeScript;
 let mutationCalls=0;
 f.chromeApi.scripting.executeScript=async payload=>{
   if(payload.args[0]==='browser_click') {
     mutationCalls++;
     return [{frameId:0,result:{ok:true}}];
   }
   return original(payload);
 };
 await assert.rejects(execute(cmd('browser_click'),f),error=>{
   assert.equal(error.message,'INJECTION_DOCUMENT_IDENTITY_UNAVAILABLE');
   assert.equal(error.dispatchState,'UNKNOWN');
   return true;
 });
 assert.equal(mutationCalls,1);
});
test('denial, navigation and revoked grants prevent page mutation',async()=>{
 for (const opts of [{deny:true},{changed:true},{expiredGrant:true}]){
  const f=fixture(opts);
  await assert.rejects(execute(cmd(),f),/USER_DENIED|TAB_CHANGED_AFTER_APPROVAL|CONTROL_GRANT_EXPIRED/);
  assert.equal(f.state.injections.includes('browser_click'),false);
 }
});
test('send requires exact conversation before AND after approval',async()=>{
 const f=fixture({conversationChanged:true});
 await assert.rejects(execute(cmd('agent_send'),f),/CONVERSATION_CHANGED_AFTER_APPROVAL/);
 assert.equal(f.state.injections.includes('agent_send'),false);
 const ok=fixture();
 const result=await execute(cmd('agent_send'),ok);
 assert.equal(result.sent,true);
 assert.deepEqual(ok.state.injections,['agent_context','agent_context','agent_send']);
});
test('invalid/sensitive payload and unknown origins fail without request',async()=>{
 for(const c of [
  {...cmd('agent_send'),args:{...cmd().args,text:'api_key=sk-test-12345678901234567890'}},
  {...cmd(),args:{...cmd().args,selector:'x'.repeat(301)}},
  {...cmd(),expires:Date.now()-1}
 ]) {
  const f=fixture();
  await assert.rejects(execute(c,f));
  assert.equal(f.state.approvalCount,0);
 }
 const f=fixture({badOrigin:true});
 await assert.rejects(execute(cmd(),f),/ORIGIN_NOT_PERMITTED/);
 assert.equal(f.state.approvalCount,0);
});

test('manual stop between approval and DOM action blocks mutation',async()=>{
 const f=fixture();
 let calls=0;
 await assert.rejects(
   dispatchMutation(cmd(),f.chromeApi,{
     approvals:f.approvals,
     controlGrant:f.controlGrant,
     uuid:()=> 'fixedid',
     stillEnabled:async()=>++calls<2
   }),
   /BACKGROUND_CONTROL_STOPPED/
 );
 assert.equal(f.state.injections.includes('browser_click'),false);
 assert.equal(f.state.approvalCount,1);
});
test('disabled lab blocks mutation before approval request',async()=>{
 const f=fixture();
 await assert.rejects(
   dispatchMutation(cmd(),f.chromeApi,{
     approvals:f.approvals,controlGrant:f.controlGrant,
     stillEnabled:async()=>false
   }),
   /BACKGROUND_CONTROL_STOPPED/
 );
 assert.equal(f.state.approvalCount,0);
 assert.equal(f.state.injections.length,0);
});


test('agent_send rejects denial, changed tab, expired grant and changed conversation without dispatch',async()=>{
 for(const opts of [{deny:true},{changed:true},{expiredGrant:true},{conversationChanged:true}]){
   const f=fixture(opts);
   await assert.rejects(execute(cmd('agent_send'),f),
     /USER_DENIED|TAB_CHANGED_AFTER_APPROVAL|CONTROL_GRANT_EXPIRED|CONVERSATION_CHANGED_AFTER_APPROVAL/);
   assert.equal(f.state.injections.includes('agent_send'),false,JSON.stringify(opts));
   assert.equal(f.state.approvalCount,1,JSON.stringify(opts));
 }
});

test('revoked grant after approval blocks agent_send even if preflight succeeded',async()=>{
 const f=fixture();
 let grantChecks=0;
 const controlGrant=async()=>++grantChecks===1?Date.now()+120000:null;
 await assert.rejects(
   dispatchMutation(cmd('agent_send'),f.chromeApi,{
     approvals:f.approvals,controlGrant,stillEnabled:async()=>true,uuid:()=> 'revoked'
   }),
   /CONTROL_GRANT_EXPIRED/
 );
 assert.equal(grantChecks,2);
 assert.deepEqual(f.state.injections,['agent_context']);
 assert.equal(f.state.approvalCount,1);
});

test('command expires during approval: agent_send is never injected',async()=>{
 const f=fixture();
 let clock=10000;
 const approvals={request:async()=>{f.state.approvalCount++;clock+=2000;}};
 const request={...cmd('agent_send'),expires:clock+1000};
 await assert.rejects(
   dispatchMutation(request,f.chromeApi,{
     approvals,controlGrant:async()=>clock+120000,
     stillEnabled:async()=>true,now:()=>clock,uuid:()=> 'expired'
   }),
   /APPROVAL_EXPIRED/
 );
 assert.deepEqual(f.state.injections,['agent_context']);
 assert.equal(f.state.approvalCount,1);
});

test('changed target metadata after approval blocks browser_click',async()=>{
 const f=fixture();
 const realInject=f.chromeApi.scripting.executeScript;
 let descriptions=0;
 f.chromeApi.scripting.executeScript=async payload=>{
   const result=await realInject(payload);
   if(payload.args[0]==='describe' && ++descriptions===2)
     return [{...result[0],result:{...result[0].result,text:'Different target'}}];
   return result;
 };
 await assert.rejects(execute(cmd('browser_click'),f),/TARGET_CHANGED_AFTER_APPROVAL/);
 assert.equal(descriptions,2);
 assert.equal(f.state.injections.includes('browser_click'),false);
});

test('host permission revoked after approval blocks mutation',async()=>{
 const f=fixture();
 const hasPermission=f.chromeApi.permissions.contains;
 f.chromeApi.permissions.contains=async (...args)=>
   f.state.allowAt ? hasPermission(...args) : false;
 await assert.rejects(execute(cmd('agent_send'),f),/HOST_PERMISSION_MISSING/);
 assert.equal(f.state.injections.includes('agent_send'),false);
});

test('missing Claude grant is a provably blocked pre-send action',async()=>{
 const f=fixture();
 await assert.rejects(dispatchMutation(cmd('agent_send'),f.chromeApi,{
   approvals:f.approvals,controlGrant:async()=>null,stillEnabled:async()=>true
 }),e=>{
   assert.equal(e.message,'EXPLICIT_CONTROL_GRANT_REQUIRED');
   assert.equal(e.dispatchState,'BLOCKED');
   return true;
 });
 assert.equal(f.state.approvalCount,0);
 assert.equal(f.state.injections.includes('agent_send'),false);
});
test('user denial is blocked, bad context is not performed, neither sends',async()=>{
 for(const [opts,state] of [[{deny:true},'BLOCKED'],[{conversationChanged:true},'NOT_PERFORMED']]){
  const f=fixture(opts);
  await assert.rejects(execute(cmd('agent_send'),f),e=>{
   assert.equal(e.dispatchState,state);return true;
  });
  assert.equal(f.state.injections.includes('agent_send'),false);
 }
});
test('unknown outcome after DOM send injection remains UNKNOWN',async()=>{
 const f=fixture();
 const original=f.chromeApi.scripting.executeScript;
 f.chromeApi.scripting.executeScript=async payload=>{
  if(payload.args[0]==='agent_send')throw Error('INJECTION_RESPONSE_LOST');
  return original(payload);
 };
 await assert.rejects(execute(cmd('agent_send'),f),e=>{
  assert.equal(e.message,'DOCUMENT_BOUND_INJECTION_FAILED');
  assert.equal(e.dispatchState,'UNKNOWN');
  return true;
 });
 assert.equal(f.state.injections.includes('agent_send'),false);
 assert.equal(f.state.approvalCount,1);
});

test('mutation failures expose stage-aware bounded failure metadata',async()=>{
 const f=fixture();
 f.chromeApi.permissions.contains=async()=>{throw Error('secret DOM and URL detail');};
 await assert.rejects(execute(cmd('agent_send'),f),e=>{
   assert.equal(e.dispatchState,'NOT_PERFORMED');
   assert.deepEqual(Object.keys(e.failure).sort(),['code','durationMs','schemaVersion','stage']);
   assert.equal(e.failure.schemaVersion,1);
   assert.equal(e.failure.stage,'PRECHECK');
   assert.equal(e.failure.code,'MUTATION_PRECHECK_FAILED');
   assert.ok(Number.isSafeInteger(e.failure.durationMs));
   return true;
 });
 assert.equal(f.state.injections.includes('agent_send'),false);
});

test('unclassified preflight errors emit safe PRECHECK code and never send',async()=>{
 const f=fixture();
 f.chromeApi.permissions.contains=async()=>{ throw Error('unsafe details from browser'); };
 await assert.rejects(execute(cmd('agent_send'),f),e=>{
   assert.equal(e.message,'MUTATION_PRECHECK_FAILED');
   assert.equal(e.dispatchState,'NOT_PERFORMED');
   return true;
 });
 assert.equal(f.state.approvalCount,0);
 assert.equal(f.state.injections.includes('agent_send'),false);
});
test('unclassified approval errors emit safe APPROVAL code and never send',async()=>{
 const f=fixture();
 f.approvals.request=async()=>{ f.state.approvalCount++; throw Error('unsafe approval payload'); };
 await assert.rejects(execute(cmd('agent_send'),f),e=>{
   assert.equal(e.message,'MUTATION_APPROVAL_FAILED');
   assert.equal(e.dispatchState,'NOT_PERFORMED');
   return true;
 });
 assert.equal(f.state.approvalCount,1);
 assert.equal(f.state.injections.includes('agent_send'),false);
});
test('unclassified revalidation errors emit safe REVALIDATION code and never send',async()=>{
 const f=fixture();
 f.chromeApi.permissions.contains=async()=>{
   if (!f.state.allowAt) throw Error('unsafe URL and DOM details');
   return true;
 };
 await assert.rejects(execute(cmd('agent_send'),f),e=>{
   assert.equal(e.message,'MUTATION_REVALIDATION_FAILED');
   assert.equal(e.dispatchState,'NOT_PERFORMED');
   return true;
 });
 assert.equal(f.state.approvalCount,1);
 assert.equal(f.state.injections.includes('agent_send'),false);
});


function providerFixture({deny=false,conversationChanged=false,grant=true}={}) {
  const state={injections:[],targets:[],approvalCount:0,allowAt:true,documentId:'document-provider-0001'};
  const chromeApi={
    tabs:{get:async()=>({id:9,url:'https://claude.ai/chat/abcdefghi',title:'Test'})},
    storage:{local:{get:async key=>key==='sites'
      ?{sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}}}:{adapters:'{}'}}},
    permissions:{contains:async()=>true},
    scripting:{executeScript:async({args,target,world})=>{
      const [name,details]=args;state.injections.push(name);state.targets.push({target,world,name});
      const response=result=>[{
        documentId:target.documentIds?.[0]||state.documentId,frameId:0,result
      }];
      if(name==='agent_context')return response({verified:true,origin:'https://claude.ai',
        conversationId:conversationChanged&&!state.allowAt?'other12345':'abcdefghi'});
      if(name==='provider_prepare')return response({prepared:true,requestId:details.requestId,preparedId:details.preparedId,
        expiresAt:details.expiresAt,payloadHash:details.payloadHash,
        sideEffect:'composer-filled-no-send',clickedSend:false});
      if(name==='provider_commit')return response({clickedSend:true,requestId:details.requestId,preparedId:details.preparedId,payloadHash:details.payloadHash,clickedAt:new Date().toISOString()});
      return response({ok:true});
    }}
  };
  const approvals={request:async()=>{state.approvalCount++;state.allowAt=false;if(deny)throw Error('USER_DENIED');}};
  const controlGrant=async()=>grant?Date.now()+120000:null;
  return {chromeApi,approvals,controlGrant,state};
}
const providerCommand=(name='provider_prepare')=>({
  id:'provider_cmd_01',name,expires:Date.now()+90000,
  args:{requestId:'request_0001',taskId:'task_000001',providerId:'claude',tabId:9,
    origin:'https://claude.ai',conversationId:'abcdefghi',epoch:7,
    message:'Review this isolated test.',payloadHash:'a'.repeat(64),
    preparedId:'prepared_001',expiresAt:new Date(Date.now()+60000).toISOString(),
    fencingToken:'f'.repeat(64)}
});

test('provider_prepare requires approval and returns explicit no-send receipt',async()=>{
  const f=providerFixture();
  const result=await dispatchMutation(providerCommand(),f.chromeApi,{
    approvals:f.approvals,controlGrant:f.controlGrant,stillEnabled:async()=>true,uuid:()=> 'fixedid'
  });
  assert.equal(result.prepared,true);
  assert.equal(result.clickedSend,false);
  assert.equal(result.sideEffect,'composer-filled-no-send');
  assert.deepEqual(f.state.injections,['agent_context','agent_context','provider_prepare']);
  assert.equal(f.state.approvalCount,1);
});

test('provider_commit requires approval and exact revalidated conversation',async()=>{
  const f=providerFixture();
  const result=await dispatchMutation(providerCommand('provider_commit'),f.chromeApi,{
    approvals:f.approvals,controlGrant:f.controlGrant,stillEnabled:async()=>true,uuid:()=> 'fixedid'
  });
  assert.equal(result.clickedSend,true);
  assert.ok(result.clickedAt);
  assert.deepEqual(f.state.injections,['agent_context','agent_context','provider_commit']);
  assert.equal(f.state.approvalCount,1);
});

test('provider stages fail closed on denial, conversation change and missing local grant',async()=>{
  for(const opts of [{deny:true},{conversationChanged:true},{grant:false}]) {
    const f=providerFixture(opts);
    await assert.rejects(dispatchMutation(providerCommand(),f.chromeApi,{
      approvals:f.approvals,controlGrant:f.controlGrant,stillEnabled:async()=>true,uuid:()=> 'fixedid'
    }));
    assert.equal(f.state.injections.includes('provider_prepare'),false);
    assert.equal(f.state.approvalCount,opts.grant===false?0:1);
  }
});


test('Chat-approved session suppresses per-action approval only for agent_send',async()=>{
 const f=fixture();
 let statusEpoch;
 const sessionAuthorization={
   status:async epoch=>{statusEpoch=epoch;return {active:true,expiresAt:Date.now()+120000};},
   require:async identity=>{
     assert.equal(identity.origin,'https://claude.ai');
     assert.equal(identity.tabId,9);
     assert.equal(identity.command,'agent_send');
     assert.equal(identity.bridgeEpoch,'bridge-epoch-0001');
     return Date.now()+120000;
   }
 };
 const request={...cmd('agent_send'),bridgeEpoch:'bridge-epoch-0001'};
 const result=await dispatchMutation(request,f.chromeApi,{
   approvals:f.approvals,
   controlGrant:async()=>{throw Error('LEGACY_GRANT_MUST_NOT_BE_USED');},
   sessionAuthorization,stillEnabled:async()=>true,uuid:()=> 'session-test'
 });
 assert.equal(result.sent,true);
 assert.equal(f.state.approvalCount,0);
 assert.equal(statusEpoch,'bridge-epoch-0001');
 assert.deepEqual(f.state.injections,['agent_context','agent_context','agent_send']);
});

test('Chat-approved session suppresses per-action approval for provider prepare and commit',async()=>{
 for(const name of ['provider_prepare','provider_commit']) {
   const f=providerFixture();
   const sessionAuthorization={
     status:async epoch=>({active:epoch==='bridge-epoch-0001',expiresAt:Date.now()+120000}),
     require:async identity=>{
       assert.equal(identity.origin,'https://claude.ai');
       assert.equal(identity.tabId,9);
       assert.equal(identity.command,name);
       assert.equal(identity.bridgeEpoch,'bridge-epoch-0001');
       return Date.now()+120000;
     }
   };
   const request={...providerCommand(name),bridgeEpoch:'bridge-epoch-0001'};
   const result=await dispatchMutation(request,f.chromeApi,{
     approvals:f.approvals,
     controlGrant:async()=>{throw Error('LEGACY_GRANT_MUST_NOT_BE_USED');},
     sessionAuthorization,stillEnabled:async()=>true,uuid:()=> 'session-provider'
   });
   assert.equal(name==='provider_prepare'?result.clickedSend===false:result.clickedSend===true,true);
   assert.equal(f.state.approvalCount,0);
   assert.deepEqual(f.state.injections,['agent_context','agent_context',name]);
 }
});

test('Chat-approved session never authorizes arbitrary browser clicks or fills',async()=>{
 for(const name of ['browser_click','browser_fill']) {
   const f=fixture({deny:true});
   const sessionAuthorization={
     status:async()=>({active:true,expiresAt:Date.now()+120000}),
     require:async()=>{throw Error('SESSION_CAPABILITY_DENIED');}
   };
   await assert.rejects(dispatchMutation(cmd(name),f.chromeApi,{
     approvals:f.approvals,controlGrant:f.controlGrant,sessionAuthorization,
     stillEnabled:async()=>true,uuid:()=> 'session-no-click'
   }),/USER_DENIED/);
   assert.equal(f.state.approvalCount,1);
   assert.equal(f.state.injections.includes(name),false);
 }
});

test('Chat-approved session fails closed on wrong epoch, origin, capability or revoked state',async()=>{
 const cases=[
   {active:false,reason:'SESSION_EPOCH_MISMATCH'},
   {active:true,expiresAt:Date.now()+120000,requireError:'SESSION_ORIGIN_DENIED'}
 ];
 for(const item of cases) {
   const f=fixture();
   const sessionAuthorization={
     status:async()=>({active:item.active,reason:item.reason,expiresAt:item.expiresAt}),
     require:async()=>{throw Error(item.requireError||'SESSION_AUTH_REQUIRED');}
   };
   await assert.rejects(dispatchMutation({...cmd('agent_send'),bridgeEpoch:'bridge-epoch-0001'},f.chromeApi,{
     approvals:f.approvals,controlGrant:async()=>null,sessionAuthorization,
     stillEnabled:async()=>true,uuid:()=> 'session-fail-closed'
   }));
   assert.equal(f.state.injections.includes('agent_send'),false);
   assert.equal(f.state.approvalCount,0);
 }
});


test('provider_prepare failures after a lost no-send receipt stay NOT_PERFORMED',async()=>{
  for(const mode of ['explicit-preflight-failure','lost-injection-response']) {
    const f=providerFixture();
    const original=f.chromeApi.scripting.executeScript;
    f.chromeApi.scripting.executeScript=async payload=>{
      if(payload.args[0]==='provider_prepare') {
        if(mode==='explicit-preflight-failure') {
          const injected=await original(payload);
          return [{...injected[0],result:{
            error:'PROVIDER_SEND_BUTTON_NOT_READY',
            dispatchState:'NOT_PERFORMED',
            sideEffect:'composer-cleared'
          }}];
        }
        throw Error('INJECTION_RESPONSE_LOST');
      }
      return original(payload);
    };
    await assert.rejects(dispatchMutation(providerCommand(),f.chromeApi,{
      approvals:f.approvals,controlGrant:f.controlGrant,stillEnabled:async()=>true,uuid:()=> 'prepare-no-send'
    }),error=>{
      assert.equal(error.dispatchState,'NOT_PERFORMED',mode);
      if(mode==='explicit-preflight-failure') assert.equal(error.sideEffect,'composer-cleared');
      else assert.equal(error.sideEffect,'composer-draft-state-unverified');
      return true;
    });
    assert.equal(f.state.injections.includes('provider_commit'),false);
    assert.equal(f.state.approvalCount,1);
  }
});

test('provider_commit page receipt classifies pre-click failure as NOT_PERFORMED',async()=>{
  const f=providerFixture();
  const original=f.chromeApi.scripting.executeScript;
  f.chromeApi.scripting.executeScript=async payload=>{
    if(payload.args[0]==='provider_commit') {
      const injected=await original(payload);
      return [{...injected[0],result:{
        error:'PROVIDER_PREPARED_DRAFT_MISMATCH',
        dispatchState:'NOT_PERFORMED'
      }}];
    }
    return original(payload);
  };
  await assert.rejects(dispatchMutation(providerCommand('provider_commit'),f.chromeApi,{
    approvals:f.approvals,controlGrant:f.controlGrant,stillEnabled:async()=>true,uuid:()=> 'commit-preclick'
  }),error=>{
    assert.equal(error.message,'PROVIDER_PREPARED_DRAFT_MISMATCH');
    assert.equal(error.dispatchState,'NOT_PERFORMED');
    return true;
  });
});

test('provider_commit page receipt after click boundary remains UNKNOWN and carries side effect',async()=>{
  const f=providerFixture();
  const original=f.chromeApi.scripting.executeScript;
  f.chromeApi.scripting.executeScript=async payload=>{
    if(payload.args[0]==='provider_commit') {
      const injected=await original(payload);
      return [{...injected[0],result:{
        error:'SEND_CLICK_RESULT_UNVERIFIED',
        dispatchState:'UNKNOWN',
        sideEffect:'send-click-may-have-fired'
      }}];
    }
    return original(payload);
  };
  await assert.rejects(dispatchMutation(providerCommand('provider_commit'),f.chromeApi,{
    approvals:f.approvals,controlGrant:f.controlGrant,stillEnabled:async()=>true,uuid:()=> 'commit-afterclick'
  }),error=>{
    assert.equal(error.message,'SEND_CLICK_RESULT_UNVERIFIED');
    assert.equal(error.dispatchState,'UNKNOWN');
    assert.equal(error.sideEffect,'send-click-may-have-fired');
    return true;
  });
});
