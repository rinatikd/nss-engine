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
test('open control windows synchronize the background mode and mutation toggle from profile storage',()=>{
  assert.match(js,/chrome\.storage\.onChanged\.addListener/);
  assert.match(js,/changes\.bridgeBackgroundMode/);
  assert.match(js,/changes\.bridgeMutationLabMode/);
  assert.match(js,/Фоновый режим отключён в другом окне/);
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

test('lab staging parameterizes the isolated endpoint and preserves the safe default',()=>{
  const stage=readFileSync(new URL('../deployment/stage-background-lab.ps1',import.meta.url),'utf8');
  const verify=readFileSync(new URL('../deployment/verify-adapter-lab.ps1',import.meta.url),'utf8');
  const manifest=readFileSync(new URL('../deployment/write-lab-release-manifest.ps1',import.meta.url),'utf8');
  const workflow=readFileSync(new URL('../../../../.github/workflows/chrome-bridge-visual-rc.yml',import.meta.url),'utf8');
  assert.match(stage,/[int]\\$LabPort\\s*=\\s*17481/);
  assert.match(stage,/\\$labEndpoint\\s*=\\s*\\('http:\\/\\/127\\.0\\.0\\.1:\\{0\\}'\\s*-f\\s*\\$LabPort\\)/);
  assert.match(stage,/\\$labHost\\s*=\\s*\\('http:\\/\\/127\\.0\\.0\\.1:\\{0\\}\\/\\*'\\s*-f\\s*\\$LabPort\\)/);
  assert.match(stage,/\\$prodEndpoint\\s*=\\s*'http:\\/\\/127\\.0\\.0\\.1:17381'/);
  assert.match(stage,/\\$prodHost\\s*=\\s*'http:\\/\\/127\\.0\\.0\\.1:17381\\/\\*'/);
  assert.match(stage,/\\$m\\.host_permissions\\s*=\\s*\\$hosts/);
  assert.match(stage,/\\$loopbackWildcard\\s*=\\s*'http:\\/\\/127\\.0\\.0\\.1\\/\\*'/);
  assert.match(stage,/\\$original\\.Replace\\(\\$prodEndpoint,\\s*\\$labEndpoint\\)/);
  assert.match(stage,/Production Bridge endpoint retained in lab JS/);
  assert.match(stage,/if \\(-not \\$Apply\\)/);
  assert.match(verify,/[int]\\$LabPort\\s*=\\s*17481/);
  assert.match(verify,/\\$labHost\\s*=\\s*'http:\\/\\/127\\.0\\.0\\.1:\\{0\\}\\/\\*'\\s*-f\\s*\\$LabPort/);
  assert.match(manifest,/[int]\\$LabPort\\s*=\\s*17481/);
  assert.match(manifest,/endpoint=\\('http:\\/\\/127\\.0\\.0\\.1:\\{0\\}'\\s*-f\\s*\\$LabPort\\)/);
  assert.match(workflow,/stage-background-lab\\.ps1[^\\n]*-LabPort 17484/);
  assert.match(workflow,/verify-adapter-lab\\.ps1[^\\n]*-LabPort 17484/);
  assert.match(workflow,/write-lab-release-manifest\\.ps1[^\\n]*-LabPort 17484/);
});


test('background UI describes the opt-in mutation lab accurately',()=>{
  assert.match(js,/Фоновый режим: чтение доступно\. Отправка возможна только в экспериментальном Control/);
  assert.match(js,/Отправка сообщений Claude, Gemini и DeepSeek требует отдельного включения экспериментального Control/);
  assert.match(js,/Каждая команда потребует отдельного подтверждения/);
  assert.doesNotMatch(js,/Отправка сообщений Claude, Gemini и DeepSeek будет недоступна/);
});
