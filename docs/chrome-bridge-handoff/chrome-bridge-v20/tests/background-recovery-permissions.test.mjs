import test from 'node:test';
import assert from 'node:assert/strict';
import {canRecoverAllTabsSession} from '../extension/background-recovery-permissions.js';

function browser({allTabs=true,desired=true,background=true,grants=true,throwOnCheck=false}={}) {
  const inspected=[];
  return {
    inspected,
    api:{
      storage:{local:{get:async()=>({
        bridgeAllTabsMode:allTabs,bridgeConnectionDesired:desired,bridgeBackgroundMode:background
      })}},
      permissions:{contains:async ({origins})=>{
        inspected.push(origins[0]);
        if(throwOnCheck)throw Error('Chrome permissions unavailable');
        return typeof grants==='boolean'?grants:grants.includes(origins[0]);
      }}
    }
  };
}
test('all-tabs session only recovers with both Chrome wildcard scopes',async()=>{
  const v=browser();
  assert.equal(await canRecoverAllTabsSession(v.api),true);
  assert.deepEqual(v.inspected,['http://*/*','https://*/*']);
});
test('externally revoked HTTP grant prevents auto-recovery',async()=>{
  const v=browser({grants:['https://*/*']});
  assert.equal(await canRecoverAllTabsSession(v.api),false);
});
test('externally revoked HTTPS grant prevents auto-recovery',async()=>{
  const v=browser({grants:['http://*/*']});
  assert.equal(await canRecoverAllTabsSession(v.api),false);
});
test('Chrome permission API error prevents auto-recovery',async()=>{
  const v=browser({throwOnCheck:true});
  assert.equal(await canRecoverAllTabsSession(v.api),false);
});
test('missing Chrome permission API prevents auto-recovery',async()=>{
  const v=browser();delete v.api.permissions;
  assert.equal(await canRecoverAllTabsSession(v.api),false);
});
test('explicit disconnect forbids reconnect even if Chrome host grant remains',async()=>{
  const v=browser({desired:false});
  assert.equal(await canRecoverAllTabsSession(v.api),false);
  assert.deepEqual(v.inspected,[]);
});
test('background disabled forbids reconnect',async()=>{
  const v=browser({background:false});
  assert.equal(await canRecoverAllTabsSession(v.api),false);
});
test('legacy mode retains existing recovery behavior without wildcard requirements',async()=>{
  const v=browser({allTabs:false,grants:false});
  assert.equal(await canRecoverAllTabsSession(v.api),true);
  assert.deepEqual(v.inspected,[]);
});
