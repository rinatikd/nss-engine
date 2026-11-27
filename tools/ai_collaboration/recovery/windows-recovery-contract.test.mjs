// Static security regression checks. These do NOT substitute for actual
// Windows PowerShell tests or a real reboot/reconnect E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=name=>readFile(new URL('./'+name,import.meta.url),'utf8');

test('production and RC1 listeners remain observation-only',async()=>{
  const script=await read('Restore-LocalStack.ps1');
  for(const id of ['chrome-prod-server','chrome-rc1-lab']){
    const start=script.indexOf("Id='"+id+"'");
    assert.ok(start>=0,id+' missing from status inventory');
    const next=script.slice(start,start+420);
    assert.match(next,/Restorable=\$false/);
  }
  const pos=script.indexOf("Id='chrome-pr102-lab'");
  assert.ok(pos>=0);
  const pr=script.slice(pos,pos+420);
  assert.match(pr,/Restorable=\$true/);
});

test('restore never kills an occupying PID or a running tunnel',async()=>{
  for(const file of ['Restore-LocalStack.ps1','Recover-LabTunnel.ps1',
    'Recover-PowerShellDirect.ps1']){
    const s=await read(file);
    assert.doesNotMatch(s,/\bStop-Process\b|\btaskkill(?:\.exe)?\b|\bTerminate\s*\(/i,file);
  }
});

test('Windows auto-start is opt-in as current user and non-admin',async()=>{
  const s=await read('Register-StackRecovery.ps1');
  assert.match(s,/\[string\]\$Mode\s*=\s*'Check'/);
  assert.match(s,/New-ScheduledTaskTrigger\s+-AtLogOn\s+-User\s+\$userId/);
  assert.match(s,/-LogonType Interactive -RunLevel Limited/);
  assert.match(s,/if\s*\(\$Mode -eq 'Unregister'\)/);
  assert.doesNotMatch(s,/-RunLevel Highest|SYSTEM|LocalSystem/);
});

test('recovery watchdog dispatches restore only once; later attempts are read-only',async()=>{
  const s=await read('Recovery-Watchdog.ps1');
  assert.match(s,/if\(\$i -eq 1\)\{'Restore'\}else\{'Status'\}/);
  assert.match(s,/& \$script -Mode \$phase/);
  assert.doesNotMatch(s,/Invoke-Expression|EncodedCommand/);
});

test('launcher never embeds the control-plane key in command-line args',async()=>{
  const scripts=['Recover-LabTunnel.ps1','Recover-PowerShellDirect.ps1'];
  for(const filename of scripts){
    const s=await read(filename);
    assert.match(s,/ConvertTo-SecureString/);
    assert.match(s,/EnvironmentVariables\['CONTROL_PLANE_API_KEY'\]/);
    assert.doesNotMatch(s,/Arguments\s*=.*\$plain/i);
    assert.match(s,/ZeroFreeBSTR/);
  }
});

test('manifest integrity is required by both logon task and desktop shortcut',async()=>{
  const register=await read('Register-StackRecovery.ps1');
  const verify=await read('Invoke-VerifiedRecovery.ps1');
  assert.match(register,/Invoke-VerifiedRecovery\.ps1/);
  assert.match(register,/&\s+\$entrypoint\s+-Mode\s+Verify/);
  assert.match(verify,/RECOVERY_FILE_HASH_MISMATCH/);
  assert.match(verify,/Get-FileHash.*SHA256/);
});

test('one-click shortcut uses user-visible checked release, not arbitrary script',async()=>{
  const register=await read('Register-StackRecovery.ps1');
  const panel=await read('Restore-StackWithReport.ps1');
  const prepare=await read('Prepare-RecoveryRelease.ps1');
  assert.match(register,/Restore-StackWithReport\.ps1/);
  assert.match(register,/-NoProfile -Sta -File/);
  assert.match(panel,/Invoke-VerifiedRecovery\.ps1/);
  assert.match(panel,/MessageBox/);
  assert.match(prepare,/Restore-StackWithReport\.ps1/);
});

test('resumed installer verifies every staged file before updating the verifier',async()=>{
  const resume=await read('Resume-RecoveryInstallation.ps1');
  const verify=await read('Invoke-VerifiedRecovery.ps1');
  assert.match(resume,/STAGED_FILE_NOT_VERIFIED_/);
  assert.match(resume,/STAGE_DIFFERS_FROM_REVIEWED_SOURCE_/);
  assert.match(resume,/PARTIAL_INSTALLATION_SAFE_TO_RESUME/);
  assert.match(resume,/Invoke-VerifiedRecovery\.ps1\.before-fix-/);
  assert.match(resume,/& \$entry -Mode Verify/);
  assert.match(resume,/& \$entry -Mode Status/);
  assert.doesNotMatch(resume,/\bRemove-Item\b|\bgit\s+reset\b/);
  assert.match(verify,/\$expectedFiles -cnotcontains \$name/);
  assert.match(verify,/INVALID_MANIFEST_ENTRY:/);
});



test('PR102 recovery pins the current 17485 Lab port, StateRoot and extension identity',async()=>{
  const restore=await read('Restore-LocalStack.ps1');
  const tunnel=await read('Recover-LabTunnel.ps1');
  assert.ok(restore.includes('Port=17485'));
  assert.ok(restore.includes("StateDir='C:\\Engineering\\ChromeBridge-PR102-17485-State'"));
  assert.ok(restore.includes("ExtensionId='nhflbnfcaicihaepdcjacdmaddagcmcj'"));
  assert.ok(restore.includes("EnvironmentVariables['CHROME_BRIDGE_EXTENSION_ID']=$s.ExtensionId"));
  assert.doesNotMatch(restore,/17484/);
  assert.ok(tunnel.includes("$labHome='C:\\Engineering\\ChromeBridge-PR102-17485-State'"));
  assert.doesNotMatch(tunnel,/17484/);
});
