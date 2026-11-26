import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchReadOnly } from '../extension/read-only-dispatch.js';
const source = name => readFileSync(new URL('../extension/'+name,import.meta.url),'utf8');

test('mutation commands never execute in background prototype',async()=>{
 for (const name of ['agent_send','agent_new_chat','browser_click','browser_fill','browser_open']) {
   await assert.rejects(dispatchReadOnly({name},{}),/CONTROL_REQUIRES_APPROVAL_UI/);
 }
});
test('unknown command names fail closed',async()=>{

 await assert.rejects(dispatchReadOnly({name:'some_unrecognized_command'},{}),/BACKGROUND_COMMAND_NOT_MIGRATED/);
 await assert.rejects(dispatchReadOnly({name:'agent_peek'},{}),/INVALID_TAB_ID/);
 await assert.rejects(dispatchReadOnly({},{}),/INVALID_COMMAND/);
});
test('control introspection stays non-mutating',async()=>{
 const r=await dispatchReadOnly({name:'control_status'},{});
 assert.equal(r.globalEnabled,false);
 assert.equal(r.approvalPending,0);
 assert.deepEqual(r.origins,[]);
});
test('new background owner is feature gated and mutually exclusive with UI polling',()=>{
  const sw=source('background.js');
  const panel=source('control.js');
  const coordinator=source('background-coordinator.js');
  assert.match(sw,/installBackgroundCoordinator\(chrome\)/);
  assert.match(sw,/bridgeBackgroundMode === true && bridgeConnectionDesired === true/);
  assert.match(coordinator,/bridgeBackgroundMode !== true/);
  assert.match(panel,/if \(backgroundMode\)/);
  assert.match(panel,/if \(!backgroundMode\) stop\(\)/);
  assert.match(panel,/if \(running && pollAbort\) stop\(\)/);
  assert.match(source('transport-host.js'),/new Worker\('\.\/transport-worker.js'/);
  assert.match(coordinator,/reasons:\['WORKERS'\]/);
  assert.match(coordinator,/TRUSTED_CONTEXTS/);
});
test('coordinator rejects content scripts and offscreen spoofing',()=>{
  const coordinator=source('background-coordinator.js');
  assert.match(coordinator,/!sender\.tab/);
  assert.match(coordinator,/sender\.url !== chromeApi\.runtime\.getURL\(PATH\)/);
});
test('offscreen host never reads browserToken from storage',()=>{
 const host=source('transport-host.js');
 assert.doesNotMatch(host,/storage\.local|storage\.session/);
 const worker=source('transport-worker.js');
 assert.doesNotMatch(worker,/chrome\.tabs|chrome\.scripting/);
});


test('offscreen Stop is confirmed only after the transport Worker returns its stopped ACK',()=>{
 const host=source('transport-host.js');
 const worker=source('transport-worker.js');
 assert.match(host,/data\?\.type === 'stopped'/);
 assert.match(host,/WORKER_STOP_UNCONFIRMED/);
 assert.match(host,/STOP_ACK_TIMEOUT_MS/);
 assert.match(host,/worker\.postMessage\(\{type:'stop',stopId\}\)/);
 assert.match(worker,/transport\?\.stop\(\)/);
 assert.match(worker,/type:'stopped',stopId:msg\.stopId/);
});
