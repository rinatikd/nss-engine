import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatchMutation} from '../extension/mutation-dispatch.js';

function fixture({
  changed=false,deny=false,expiredGrant=false,badOrigin=false,conversationChanged=false
}={}) {
  const state={injections:[],approvalCount:0,allowAt:true,grant:Date.now()+120000};
  const url=badOrigin?'https://not-allowed.example/app':'https://claude.ai/chat/abcdefghi';
  const chromeApi={
    tabs:{get:async()=>({id:9,url:changed && !state.allowAt ?
      'https://claude.ai/chat/other12345':url,title:'Test'})},
    storage:{local:{get:async key=>key==='sites'?
      {sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}}}:{adapters:'{}'}}},
    permissions:{contains:async()=>true},
    scripting:{executeScript:async({args})=>{
      const [name,details]=args;
      state.injections.push(name);
      if(name==='describe')return [{result:{
        tag:'button',text:'Send',href:'',formAction:'',type:'button'}}];
      if(name==='agent_context')return [{result:{
        verified:true,origin:'https://claude.ai',
        conversationId:conversationChanged && !state.allowAt?'other':'abcdefghi'
      }}];
      return [{result:{ok:true,sent:name==='agent_send'}}];
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
     return [{result:{...result[0].result,text:'Different target'}}];
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
 await assert.rejects(execute(cmd('agent_send'),f),/ORIGIN_NOT_PERMITTED/);
 assert.equal(f.state.injections.includes('agent_send'),false);
});
