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

test('control_status never confuses requested connection with observed live transport',async()=>{
 const flags={bridgeBackgroundMode:true,bridgeConnectionDesired:true,
   bridgeAllTabsMode:true,bridgeMutationLabMode:true};
 const api={
   storage:{local:{get:async()=>flags}},
   permissions:{contains:async()=>true}
 };
 const absent=await dispatchReadOnly({name:'control_status'},api);
 assert.equal(absent.connectionDesired,true);
 assert.equal(absent.connected,false);
 assert.equal(absent.globalEnabled,false);
 const disconnected=await dispatchReadOnly({name:'control_status'},api,{
   transportStatus:{connected:false}
 });
 assert.equal(disconnected.connected,false);
 const live=await dispatchReadOnly({name:'control_status'},api,{
   transportStatus:{connected:true}
 });
 assert.equal(live.connected,true);
 assert.equal(live.globalEnabled,true);
});

test('control_status goes fail closed when wildcard host permissions were revoked',async()=>{
 const flags={bridgeBackgroundMode:true,bridgeConnectionDesired:true,
   bridgeAllTabsMode:true,bridgeMutationLabMode:true};
 const checks=[];
 const api={
   storage:{local:{get:async()=>flags}},
   permissions:{contains:async ({origins})=>{
     checks.push(origins[0]);return origins[0]!=='https://*/*';
   }}
 };
 const res=await dispatchReadOnly({name:'control_status'},api,{
   transportStatus:{connected:true}
 });
 assert.equal(res.connected,true);
 assert.equal(res.globalEnabled,false);
 assert.deepEqual(checks,['http://*/*','https://*/*']);
});
