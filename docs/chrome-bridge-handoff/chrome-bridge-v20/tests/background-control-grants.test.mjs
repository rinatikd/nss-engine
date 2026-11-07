import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BackgroundControlGrants} from '../extension/background-control-grants.js';

function chromeMock({site='https://claude.ai'}={}){
  const session={};
  const operations=[];
  return {
    operations,
    tabs:{get:async id=>({id,url:site+'/chat/something'})},
    storage:{
      local:{get:async()=>({sites:{'https://claude.ai':{mode:'chat',adapter:'claude'}}})},
      session:{
        setAccessLevel:async value=>operations.push(value.accessLevel),
        get:async key=>({[key]:session[key]}),
        set:async obj=>Object.assign(session,obj),
        remove:async key=>{delete session[key];}
      }
    },
    permissions:{contains:async()=>true}
  };
}
test('requires explicit gesture and per-tab allowlisted site for grant',async()=>{
 const c=chromeMock();
 const grants=new BackgroundControlGrants(c);
 await assert.rejects(grants.grant({tabId:9,durationMinutes:15,localGesture:false}),/LOCAL_GESTURE_REQUIRED/);
 await assert.rejects(grants.grant({tabId:9,durationMinutes:240,localGesture:true}),/INVALID_GRANT_DURATION/);
 const g=await grants.grant({tabId:9,durationMinutes:15,localGesture:true});
 assert.equal(g.origin,'https://claude.ai');
 assert.equal(await grants.require(g.origin,9),g.expires);
 assert.equal(await grants.require(g.origin,10),null);
 assert.equal(await grants.require('https://gemini.google.com',9),null);
 assert.ok(c.operations.every(x=>x==='TRUSTED_CONTEXTS'));
});
test('grants never apply to unknown site and can be revoked or cleared',async()=>{
 const c=chromeMock();
 const g=new BackgroundControlGrants(c);
 await g.grant({tabId:9,durationMinutes:15,localGesture:true});
 await g.revoke(9);
 assert.equal(await g.require('https://claude.ai',9),null);
 await g.grant({tabId:9,durationMinutes:15,localGesture:true});
 await g.clear();
 assert.equal(await g.require('https://claude.ai',9),null);
 const bad=new BackgroundControlGrants(chromeMock({site:'https://example.org'}));
 await assert.rejects(bad.grant({tabId:9,durationMinutes:15,localGesture:true}),/ORIGIN_NOT_PERMITTED/);
});
test('grant expires and does not automatically renew',async()=>{
 const c=chromeMock();
 let t=1000;
 const g=new BackgroundControlGrants(c,{now:()=>t});
 await g.grant({tabId:9,durationMinutes:15,localGesture:true});
 assert.ok(await g.require('https://claude.ai',9));
 t+=15*60*1000;
 assert.equal(await g.require('https://claude.ai',9),null);
});

test('status count changes after grant, revoke, expiry and clear without exposing credentials',async()=>{
 const chrome=chromeMock();
 let now=1700000000000;
 const grants=new BackgroundControlGrants(chrome,{now:()=>now});
 assert.equal(await grants.activeCount(),0);
 await grants.grant({tabId:9,durationMinutes:15,localGesture:true});
 await grants.grant({tabId:10,durationMinutes:60,localGesture:true});
 assert.equal(await grants.activeCount(),2);
 await grants.revoke(9);
 assert.equal(await grants.activeCount(),1);
 now+=60*60*1000;
 assert.equal(await grants.activeCount(),0);
 await grants.clear();
 assert.equal(await grants.activeCount(),0);
});
