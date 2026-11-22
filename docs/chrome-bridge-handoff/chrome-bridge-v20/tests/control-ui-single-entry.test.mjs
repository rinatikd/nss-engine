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
  assert.ok(stage.includes('[ValidateRange(1024,65535)][int]$LabPort = 17481'));
  assert.ok(stage.includes("$labEndpoint = ('http://127.0.0.1:{0}' -f $LabPort)"));
  assert.ok(stage.includes("$labHost = ('http://127.0.0.1:{0}/*' -f $LabPort)"));
  assert.ok(stage.includes("$prodEndpoint = 'http://127.0.0.1:17381'"));
  assert.ok(stage.includes("$prodHost = 'http://127.0.0.1:17381/*'"));
  assert.ok(stage.includes('$m.host_permissions = $hosts'));
  assert.ok(stage.includes("$loopbackWildcard = 'http://127.0.0.1/*'"));
  assert.ok(stage.includes('$original.Replace($prodEndpoint, $labEndpoint)'));
  assert.ok(stage.includes('Production Bridge endpoint retained in lab JS'));
  assert.ok(stage.includes('if (-not $Apply)'));
  assert.ok(verify.includes('[ValidateRange(1024,65535)][int]$LabPort = 17481'));
  assert.ok(verify.includes("$labHost = 'http://127.0.0.1:{0}/*' -f $LabPort"));
  assert.ok(manifest.includes('[ValidateRange(1024,65535)][int]$LabPort = 17481'));
  assert.ok(manifest.includes("endpoint=('http://127.0.0.1:{0}' -f $LabPort)"));
  assert.ok(workflow.includes('stage-background-lab.ps1 -BridgeRoot $root -CandidateRoot . -OutputRoot $out -LabPort 17484'));
  assert.ok(workflow.includes('verify-adapter-lab.ps1 -LabRoot $out -LabPort 17484'));
  assert.ok(workflow.includes('write-lab-release-manifest.ps1 -LabRoot $out'));
  assert.ok(workflow.includes('-CommitSha $env:GITHUB_SHA -LabPort 17484'));
});


test('background UI describes the opt-in mutation lab accurately',()=>{
  assert.match(js,/Фоновый режим: чтение доступно\. Отправка возможна только в экспериментальном Control/);
  assert.match(js,/Отправка сообщений Claude, Gemini и DeepSeek требует отдельного включения экспериментального Control/);
  assert.match(js,/Каждая команда потребует отдельного подтверждения/);
  assert.doesNotMatch(js,/Отправка сообщений Claude, Gemini и DeepSeek будет недоступна/);
});

test('existing PR102 Lab updater pins port 17484 and preserves the installed extension identity',()=>{
  const updater=readFileSync(new URL('../deployment/upgrade-pr102-lab.ps1',import.meta.url),'utf8');
  assert.match(updater,/\[ValidateSet\(17484\)\]\[int\]\$LabPort\s*=\s*17484/);
  assert.match(updater,/C:\\\\Engineering\\\\ChromeBridge-PR102-17484-Lab/);
  assert.match(updater,/ChromeBridge-PR102-17484-Lab-TestFixture/);
  assert.match(updater,/RUNNER_TEMP/);
  assert.match(updater,/http:\/\/127\.0\.0\.1:17484\/\*/);
  assert.match(updater,/127\.0\.0\.1:17381/);
  assert.match(updater,/127\.0\.0\.1:17382/);
  assert.match(updater,/host_permissions/);
  assert.match(updater,/loopbackPattern/);
  assert.match(updater,/PSObject\.Properties\['key'\]/);
  assert.match(updater,/chrome-bridge-pr102-lab-backup-v1/);
  assert.match(updater,/manifestSha256/);
  assert.match(updater,/RollbackFrom/);
  assert.match(updater,/No installed files changed/);
  assert.match(updater,/Chrome reload required/);
});

