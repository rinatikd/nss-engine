import test from 'node:test';
import assert from 'node:assert/strict';
import {requireOneClickControl} from '../extension/one-click-control-gate.js';
import {dispatchOneClickNavigation} from '../extension/one-click-navigation.js';

function fixture({flags=true, granted=true, failContains=false, revokeAfter=Infinity}={}){
 const events=[];
 let checks=0;
 const api={
  storage:{local:{async get(){events.push('state');return {
   bridgeConnectionDesired:flags,bridgeAllTabsMode:flags,bridgeMutationLabMode:flags
  };}}},
  permissions:{async contains({origins}){
   events.push('permission:'+origins[0]);
   checks++;
   if(failContains)throw Error('Chrome permission unavailable');
   return granted && checks<=revokeAfter;
  }},
  tabs:{async create({url}){events.push('CREATE');return {id:1,url};}}
 };
 return {api,events};
}
test('one connected session rechecks both wildcard host scopes',async()=>{
 const h=fixture();
 assert.equal(await requireOneClickControl(h.api),true);
 assert.deepEqual(h.events,['state','permission:http://*/*','permission:https://*/*']);
});
test('no Control when session is disabled',async()=>{
 const h=fixture({flags:false});
 await assert.rejects(requireOneClickControl(h.api),/ALL_TABS_CONTROL_DISABLED/);
 assert.deepEqual(h.events,['state']);
});
test('host scope removed outside Chrome Bridge blocks Control',async()=>{
 const h=fixture({revokeAfter:1});
 await assert.rejects(requireOneClickControl(h.api),/HOST_PERMISSION_REVOKED/);
});
test('permission API exception fails closed',async()=>{
 const h=fixture({failContains:true});
 await assert.rejects(requireOneClickControl(h.api),/HOST_PERMISSION_VERIFICATION_FAILED/);
});
test('missing permission API fails closed',async()=>{
 const h=fixture();
 delete h.api.permissions;
 await assert.rejects(requireOneClickControl(h.api),/HOST_PERMISSION_VERIFICATION_UNAVAILABLE/);
});
test('browser_open checks active host permissions twice and does not create after revoke',async()=>{
 const h=fixture({revokeAfter:3});
 await assert.rejects(
  dispatchOneClickNavigation({name:'browser_open',expires:Date.now()+10000,
   args:{url:'https://example.org/'}},h.api),/HOST_PERMISSION_REVOKED/
 );
 assert.equal(h.events.includes('CREATE'),false);
});
test('browser_open succeeds with uninterrupted session and no per-tab grant',async()=>{
 const h=fixture();
 const v=await dispatchOneClickNavigation({name:'browser_open',
  expires:Date.now()+10000,args:{url:'https://example.org/'}},h.api);
 assert.equal(v.tabId,1);
 assert.equal(h.events.filter(e=>e==='CREATE').length,1);
});
