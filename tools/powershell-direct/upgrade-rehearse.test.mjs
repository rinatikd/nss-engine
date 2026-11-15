import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./Upgrade-EngineeringApproval.ps1',import.meta.url),'utf8');

test('RC1 rehearsal identifies tunnel binary by verified live process, not stale fixed path',()=>{
 assert.doesNotMatch(source,/\$client\s*=\s*['"]C:\\\\Engineering\\\\chrome-bridge/i);
 assert.match(source,/Get-CimInstance Win32_Process/);
 assert.match(source,/ParentProcessId\s+-eq\s+\$id/);
 assert.match(source,/Get-Listener 18086/);
 assert.match(source,/\$script:client\s*=\s*\$resolved/);
 assert.match(source,/TUNNEL_CLIENT_IDENTITY_CHANGED/);
 assert.match(source,/ACTIVE_TUNNEL_CLIENT_NOT_FOUND/);
});

test('Rehearse exits before operator restart and does not mutate production',()=>{
 const posRehearse=source.indexOf("if($Mode -eq 'Rehearse')");
 const posRestart=source.indexOf('if(!$AuthorizeServiceRestart)');
 const posStop=source.indexOf('Stop-Verified $ready');
 assert.ok(posRehearse>0);
 assert.ok(posRestart>posRehearse);
 assert.ok(posStop>posRestart);
 assert.match(source,/PRODUCTION_CHANGED_DURING_REHEARSAL/);
});
