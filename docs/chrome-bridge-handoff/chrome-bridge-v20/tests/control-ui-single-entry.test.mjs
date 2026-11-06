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
  assert.doesNotMatch(js,/ttl\.textContent\s*=/);
  assert.match(js,/li\.append\(left, rm\)/);
});

test('isolated staging packages RC1 modules without cloning installed extension',()=>{
  const stage=readFileSync(new URL('../deployment/stage-background-lab.ps1',import.meta.url),'utf8');
  for (const name of ['control-targets.js','coordinator-ack.js','background-mode-reconnect.js','control-ui-guard.js','background-control-ui-state.js']) {
    assert.ok(stage.includes("'"+name+"'"),'Missing source file: '+name);
  }
  assert.doesNotMatch(stage,/Copy-Item\s+-LiteralPath\s+\$installed\s+-Destination\s+\$temp\b/i);
  assert.match(stage,/New-Item\s+-ItemType\s+Directory\s+-Path\s+\$temp\b/);
  assert.match(stage,/Unpackaged candidate import/);
  assert.match(stage,/Unsafe manifest icon asset path/);
});

test('lab staging remaps only the isolated fixture to 17481',()=>{
  const stage=readFileSync(new URL('../deployment/stage-background-lab.ps1',import.meta.url),'utf8');
  assert.match(stage,/\$prodEndpoint\s*=\s*'http:\/\/127\.0\.0\.1:17381'/);
  assert.match(stage,/\$labEndpoint\s*=\s*'http:\/\/127\.0\.0\.1:17481'/);
  assert.match(stage,/\$prodHost\s*=\s*'http:\/\/127\.0\.0\.1:17381\/\*'/);
  assert.match(stage,/\$labHost\s*=\s*'http:\/\/127\.0\.0\.1:17481\/\*'/);
  assert.match(stage,/\$m\.host_permissions\s*=\s*\$hosts/);
  assert.match(stage,/\$original\.Replace\(\$prodEndpoint,\s*\$labEndpoint\)/);
  assert.match(stage,/Production Bridge endpoint retained in lab JS/);
  assert.match(stage,/if \(-not \$Apply\)/);
});
