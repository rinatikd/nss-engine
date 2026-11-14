// These are source/security contracts; a Windows build and real Chrome
// Native Messaging E2E are required before a PASS can be declared.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const local=p=>readFile(new URL('./'+p,import.meta.url),'utf8');

test('native host accepts only fixed status and restore actions',async()=>{
  const s=await local('native-host/Program.cs');
  assert.match(s,/action is not \("restore" or "status"\)/);
  assert.match(s,/INVALID_REQUEST_SHAPE/);
  assert.match(s,/ACTION_NOT_ALLOWED/);
  assert.match(s,/MaxInbound = 4096/);
  assert.match(s,/MaxOutbound = 32768/);
  assert.doesNotMatch(s,/ProcessStartInfo\(action|ProcessStartInfo\(root/);
});

test('native host does not accept scripts, arguments or file paths from extension',async()=>{
  const s=await local('native-host/Program.cs');
  assert.match(s,/root\.EnumerateObject\(\)\.Count\(\) != 1/);
  assert.match(s,/ArgumentList\.Add\("-File"\)/);
  assert.match(s,/ArgumentList\.Add\(Entrypoint\)/);
  assert.match(s,/Path\.Combine\(ReleaseRoot, "Invoke-VerifiedRecovery.ps1"\)/);
});

test('installer restricts extension ID and avoids overriding an existing native host',async()=>{
  const s=await local('Install-RecoveryNativeHost.ps1');
  assert.match(s,/ehmllfabjbfcinaigionjggbgonkokfg/);
  assert.match(s,/chrome-extension:\/\//);
  assert.match(s,/NATIVE_HOST_ALREADY_REGISTERED/);
  assert.match(s,/allowed_origins/);
  assert.match(s,/UTF8Encoding\(\$false\)/);
  assert.match(s,/\[ValidateSet\('Check','Install','Uninstall'\)\]/);
});

test('native host starts only bundled verified recovery without inherited secrets',async()=>{
  const s=await local('native-host/Program.cs');
  assert.match(s,/Invoke-VerifiedRecovery.ps1/);
  assert.match(s,/psi\.Environment\.Remove\(key\)/);
  assert.match(s,/Kill\(entireProcessTree: true\)/);
  assert.match(s,/RECOVERY_TIMEOUT/);
  assert.doesNotMatch(s,/cmd\.exe|Invoke-Expression|powershell -enc/i);
});
