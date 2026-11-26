import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReadOnly } from '../extension/read-only-dispatch.js';

const url='https://claude.ai/chat/abcdefghi';
const baseCommand={
  id:'reply-read-01',name:'provider_reply_peek',
  args:{tabId:9,expectedOrigin:'https://claude.ai',expectedConversationId:'abcdefghi'}
};
function fixture({result,changedUrl=false,permission=true}={}) {
  const state={calls:[],tabReads:0};
  const chromeApi={
    tabs:{get:async()=>{state.tabReads++;return {id:9,url:changedUrl&&state.tabReads>1?'https://claude.ai/chat/other12345':url};}},
    storage:{local:{get:async key=>key==='sites'
      ?{sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}}}
      :{adapters:'{}'}}},
    permissions:{contains:async()=>permission},
    scripting:{executeScript:async payload=>{
      state.calls.push(payload);
      return [{result:result??{
        count:2,replyIndex:2,text:'Synthetic Claude answer',chars:23,
        generating:false,origin:'https://claude.ai',conversationId:'abcdefghi',url
      }}];
    }}
  };
  return {chromeApi,state};
}

test('reply snapshot uses only the exact approved chat tab and read-only page action',async()=>{
 const f=fixture();
 const out=await dispatchReadOnly(baseCommand,f.chromeApi);
 assert.equal(out.count,2);
 assert.equal(out.replyIndex,2);
 assert.equal(out.redacted,false);
 assert.equal(f.state.calls.length,1);
 assert.equal(f.state.calls[0].target.tabId,9);
 assert.equal(f.state.calls[0].args[0],'provider_reply_peek');
 assert.equal(f.state.calls[0].args[1].expectedOrigin,'https://claude.ai');
 assert.equal(f.state.calls[0].args[1].expectedConversationId,'abcdefghi');
});

test('reply snapshot redacts a secret and exposes redacted marker to Bridge',async()=>{
 const raw='Synthetic output Bearer abcdefghijklmnopqrstuvwxyz1234567890';
 const f=fixture({result:{
   count:2,replyIndex:2,text:raw,chars:raw.length,generating:false,
   origin:'https://claude.ai',conversationId:'abcdefghi',url
 }});
 const out=await dispatchReadOnly(baseCommand,f.chromeApi);
 assert.equal(out.redacted,true);
 assert.equal(out.text.includes('abcdefghijklmnopqrstuvwxyz1234567890'),false);
 assert.equal(out.chars,out.text.length);
});

test('identity mismatch, wrong URL and missing host permission fail closed',async()=>{
 const badConversation=fixture({result:{
   count:2,replyIndex:2,text:'A reply',chars:7,generating:false,
   origin:'https://claude.ai',conversationId:'another123',url
 }});
 await assert.rejects(()=>dispatchReadOnly(baseCommand,badConversation.chromeApi),/INVALID_PROVIDER_REPLY_SNAPSHOT/);
 const changed=fixture({changedUrl:true});
 await assert.rejects(()=>dispatchReadOnly(baseCommand,changed.chromeApi),/TAB_CHANGED_DURING_PROVIDER_REPLY_READ/);
 const denied=fixture({permission:false});
 await assert.rejects(()=>dispatchReadOnly(baseCommand,denied.chromeApi),/HOST_PERMISSION_MISSING/);
});

test('mutating and unknown commands cannot be smuggled through read-only dispatcher',async()=>{
 const f=fixture();
 await assert.rejects(()=>dispatchReadOnly({...baseCommand,name:'provider_commit'},f.chromeApi),/CONTROL_REQUIRES_APPROVAL_UI/);
 await assert.rejects(()=>dispatchReadOnly({...baseCommand,name:'arbitrary_js_eval'},f.chromeApi),/BACKGROUND_COMMAND_NOT_MIGRATED/);
 assert.equal(f.state.calls.length,0);
});
