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
