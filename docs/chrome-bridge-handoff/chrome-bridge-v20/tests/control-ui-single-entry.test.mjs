import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('../extension/control.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../extension/control.js',import.meta.url),'utf8');

test('global Control buttons remain available',()=>{
  assert.match(html,/id="backgroundGrantAll"/);
  assert.match(html,/id="backgroundRevokeAll"/);
  assert.match(html,/id="backgroundGrantMinutes"/);
  assert.match(js,/eligibleBackgroundControlTabs/);
  assert.match(js,/clear-background-controls/);
});
test('duplicate per-tab Control controls and their handlers are absent',()=>{
  assert.doesNotMatch(html,/id="backgroundGrantTabId"|id="backgroundGrant"|id="backgroundRevoke"/);
  assert.doesNotMatch(js,/selectedBackgroundTab|\$\('backgroundGrant'\)|\$\('backgroundRevoke'\)/);
});
test('site list does not create redundant legacy Control buttons or misleading status',()=>{
  assert.doesNotMatch(js,/dataset\.connectControl|dataset\.disconnectControl|dataset\.ttl/);
  assert.doesNotMatch(js,/Управление отключено/);
  assert.match(js,/li\.append\(left, rm\)/);
});
