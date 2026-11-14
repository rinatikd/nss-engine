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
  assert.match(s,/\[string\]\$Mode='Check'/);
  assert.match(s,/New-ScheduledTaskTrigger\s+-AtLogOn\s+-User\s+\$userId/);
  assert.match(s,/-LogonType Interactive -RunLevel Limited/);
  assert.match(s,/if\(\$Mode -eq 'Unregister'\)/);
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
  assert.match(register,/& \$script -Mode Verify/);
  assert.match(verify,/RECOVERY_FILE_HASH_MISMATCH/);
  assert.match(verify,/Get-FileHash.*SHA256/);
});
