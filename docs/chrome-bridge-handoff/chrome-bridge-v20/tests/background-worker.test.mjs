import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchReadOnly } from '../extension/read-only-dispatch.js';
const source = name => readFileSync(new URL('../extension/'+name,import.meta.url),'utf8');

test('mutation commands never execute in background prototype',()=>{
 for (const name of ['agent_send','agent_new_chat','browser_click','browser_fill','browser_open']) {
   assert.throws(()=>dispatchReadOnly({name},{}),/CONTROL_REQUIRES_APPROVAL_UI/);
 }
});
test('unknown and tab-reading commands fail closed until origin checks are migrated',()=>{
 assert.throws(()=>dispatchReadOnly({name:'browser_read'},{}),/BACKGROUND_COMMAND_NOT_MIGRATED/);
 assert.throws(()=>dispatchReadOnly({name:'agent_peek'},{}),/BACKGROUND_COMMAND_NOT_MIGRATED/);
 assert.throws(()=>dispatchReadOnly({},{}),/INVALID_COMMAND/);
});
test('only transport inspection is permitted as baseline',()=>{
 const r=dispatchReadOnly({name:'control_status'},{});
 assert.equal(r.globalEnabled,false);
 assert.equal(r.approvalPending,0);
 assert.deepEqual(r.origins,[]);
});
test('no duplicate poller is enabled before a guarded migration',()=>{
 const sw=source('background.js');
 assert.doesNotMatch(sw,/installBackgroundCoordinator|startBackgroundTransport|transport-host/);
 const host=source('transport-host.js');
 assert.match(host,/new Worker\('\.\/transport-worker.js'/);
 const coordinator=source('background-coordinator.js');
 assert.match(coordinator,/reasons:\['WORKERS'\]/);
 assert.match(coordinator,/TRUSTED_CONTEXTS/);
});
test('offscreen host never reads browserToken from storage',()=>{
 const host=source('transport-host.js');
 assert.doesNotMatch(host,/storage\.local|storage\.session/);
 const worker=source('transport-worker.js');
 assert.doesNotMatch(worker,/chrome\.tabs|chrome\.scripting/);
});
