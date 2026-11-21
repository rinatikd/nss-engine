import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('../extension/control.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../extension/one-click-control.js',import.meta.url),'utf8');

test('single-entry control panel exposes Connect, Disconnect and local recovery',()=>{
  assert.match(html,/id="connect"/);
  assert.match(html,/id="disconnect"/);
  assert.match(html,/id="recover"/);
  assert.match(html,/id="pairing-key"/);
  assert.match(js,/session\.connect/);
  assert.match(js,/session\.disconnect/);
  assert.match(js,/requestLocalRecovery/);
});
test('legacy global grant controls are not exposed in the single-entry panel',()=>{
  assert.doesNotMatch(html,/backgroundGrantAll|backgroundRevokeAll|backgroundGrantMinutes/);
  assert.doesNotMatch(js,/clear-background-controls|grant-background-control/);
});
test('connect and disconnect require trusted user gestures',()=>{
  assert.match(js,/if \(!e\.isTrusted \|\| busy\) return/);
  assert.match(js,/target:'bridge-coordinator',type:'stop-background'/);
});
