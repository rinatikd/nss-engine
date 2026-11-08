import {test} from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReadOnly } from '../extension/read-only-dispatch.js';

function mock({tabUrl='https://claude.ai/chat/test',allowed=true,site=true,changed=false}={}){
 const tab={id:42,url:tabUrl,title:'Claude',active:true,windowId:3};
 return {
   tabs:{get:async id=>id===42?(changed?{...tab,url:'https://evil.example'}:tab):{id,url:'https://private.example',title:'Private',active:false,windowId:3},query:async()=>[tab,{id:99,url:'https://private.example',title:'Private',active:false,windowId:3}]},
   storage:{local:{get:async()=>({sites:site?{'https://claude.ai':{mode:'chat',adapter:'claude'}}:{}})}},
   permissions:{contains:async()=>allowed},
   scripting:{executeScript:async()=>[{result:{text:'sample text',links:[{text:'Page',url:'https://claude.ai/'}]}}]}
 };
}
test('only explicitly added HTTPS hosts with Chrome permissions appear in tabs',async()=>{
 let rows=await dispatchReadOnly({name:'browser_tabs'},mock());
 assert.equal(rows.length,1);
 assert.equal(rows[0].tabId,42);
 rows=await dispatchReadOnly({name:'browser_tabs'},mock({allowed:false}));
 assert.deepEqual(rows,[]);
 rows=await dispatchReadOnly({name:'browser_tabs'},mock({site:false}));
 assert.deepEqual(rows,[]);
});
test('background read requires approved host and revalidates tab identity',async()=>{
 const res=await dispatchReadOnly({name:'browser_read',args:{tabId:42}},mock());
 assert.equal(res.text,'sample text');
 await assert.rejects(dispatchReadOnly({name:'browser_read',args:{tabId:42}},mock({allowed:false})),/HOST_PERMISSION_MISSING/);
 await assert.rejects(dispatchReadOnly({name:'browser_read',args:{tabId:42}},mock({tabUrl:'http://claude.ai/'})),/ORIGIN_NOT_PERMITTED/);
 await assert.rejects(dispatchReadOnly({name:'browser_read',args:{tabId:42}},mock({changed:true})),/ORIGIN_NOT_PERMITTED/);
});
test('background read rejects invalid selectors and denies mutations without UI',async()=>{
 await assert.rejects(dispatchReadOnly({name:'browser_read',args:{tabId:42,selector:'x'.repeat(301)}},mock()),/INVALID_SELECTOR/);
 await assert.rejects(dispatchReadOnly({name:'agent_send'},mock()),/CONTROL_REQUIRES_APPROVAL_UI/);
});

test('MV3 background agent_bind probe supports empty composer without any send',async()=>{
 const c=mock();
 const calls=[];
 c.scripting.executeScript=async req=>{
   calls.push(req);
   assert.equal(req.args[0],'agent_selftest');
   assert.equal(req.args[2],'https://claude.ai');
   assert.equal(req.args[1].adapter.origin,'https://claude.ai');
   return [{result:{composer:{matched:1,visible:1},send:{matched:1,visible:0}}}];
 };
 const probe=await dispatchReadOnly({name:'agent_probe',args:{tabId:42}},c);
 assert.deepEqual(probe,{adapter:'claude',verified:false});
 assert.equal(calls.length,1);
});
test('MV3 background selftest and conversation-context read use safe injection',async()=>{
 const c=mock();
 const actions=[];
 c.scripting.executeScript=async req=>{
   actions.push(req.args[0]);
   if(req.args[0]==='agent_selftest')
     return [{result:{composer:{matched:1,visible:1},send:{matched:0,visible:0}}}];
   return [{result:{verified:false,origin:'https://claude.ai',conversationId:null}}];
 };
 const census=await dispatchReadOnly({name:'agent_selftest',args:{tabId:42}},c);
 assert.equal(census.composer.visible,1);
 const ctx=await dispatchReadOnly({name:'agent_context',args:{tabId:42}},c);
 assert.equal(ctx.verified,false);
 assert.equal(ctx.conversationId,null);
 assert.deepEqual(actions,['agent_selftest','agent_context']);
});
test('MV3 background peek redacts secrets and denies changed tabs',async()=>{
 const c=mock();
 c.scripting.executeScript=async req=>{
   assert.equal(req.args[0],'agent_peek');
   return [{result:{count:0,text:'',generating:false,composerFound:true,url:'https://claude.ai/chat/test'}}];
 };
 assert.equal((await dispatchReadOnly({name:'agent_peek',args:{tabId:42}},c)).count,0);
 const changed=mock();
 changed.tabs.get=async id=>id===42
   ? {id,url:changed._after?'https://claude.ai/chat/other':'https://claude.ai/chat/test',title:'Claude'}
   : null;
 changed.scripting.executeScript=async()=>{changed._after=true;return [{result:{composer:{visible:1},send:{visible:1}}}];};
 await assert.rejects(dispatchReadOnly({name:'agent_probe',args:{tabId:42}},changed),
   /TAB_CHANGED_DURING_READ/);
});
test('background diagnostics reject unapproved origins and malformed overrides',async()=>{
 const c=mock({allowed:false});
 await assert.rejects(dispatchReadOnly({name:'agent_probe',args:{tabId:42}},c),/HOST_PERMISSION_MISSING/);
 const site=mock();
 site.storage.local.get=async keys=>{
   if(keys==='adapters')return {adapters:'{'};
   return {sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}}};
 };
 await assert.rejects(dispatchReadOnly({name:'agent_selftest',args:{tabId:42}},site),
   /INVALID_ADAPTER_CONFIGURATION/);
 await assert.rejects(dispatchReadOnly({name:'agent_new_chat',args:{tabId:42}},mock()),
   /CONTROL_REQUIRES_APPROVAL_UI/);
 await assert.rejects(dispatchReadOnly({name:'agent_send',args:{tabId:42}},mock()),
   /CONTROL_REQUIRES_APPROVAL_UI/);
});
