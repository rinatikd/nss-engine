# Explicit opt-in installer of a native host for the PINNED PR113 lab extension.
[CmdletBinding()]
param([ValidateSet('Check','Install','Uninstall')][string]$Mode='Check')
$ErrorActionPreference='Stop'
$hostName='com.chrome_bridge.recovery'
$labExtensionId='ehmllfabjbfcinaigionjggbgonkokfg'
$release='C:\Engineering\ChromeBridge-Recovery-Release'
$entry=Join-Path $release 'Invoke-VerifiedRecovery.ps1'
$hostDir=Join-Path $release 'native-host'
$exe=Join-Path $hostDir 'ChromeBridge.RecoveryHost.exe'
$manifest=Join-Path $hostDir ($hostName+'.json')
$regPath='HKCU:\Software\Google\Chrome\NativeMessagingHosts\'+$hostName
$source=Join-Path $PSScriptRoot 'native-host'
$project=Join-Path $source 'ChromeBridge.RecoveryHost.csproj'
if($Mode -eq 'Check'){
  $existing=Get-ItemProperty -LiteralPath $regPath -ErrorAction SilentlyContinue
  [PSCustomObject]@{Host=$hostName;Installed=[bool]$existing;
    ExecutablePresent=(Test-Path -LiteralPath $exe -PathType Leaf);
    ExtensionId=$labExtensionId} | ConvertTo-Json
  return
}
if($Mode -eq 'Uninstall'){
  if(Test-Path -LiteralPath $regPath){Remove-Item -LiteralPath $regPath -Recurse -Force}
  Write-Host 'RECOVERY_NATIVE_HOST_REGISTRATION_REMOVED'
  return
}
if(!(Test-Path -LiteralPath $entry -PathType Leaf) -or
   !(Test-Path -LiteralPath $project -PathType Leaf)){
  throw 'INSTALL_PREREQUISITES_MISSING'
}
if(Test-Path -LiteralPath $regPath){throw 'NATIVE_HOST_ALREADY_REGISTERED'}
if(Test-Path -LiteralPath $exe){throw 'NATIVE_HOST_EXECUTABLE_EXISTS_REVIEW_BEFORE_REPLACING'}
& $entry -Mode Verify | Out-Null
$dotnet='C:\Program Files\dotnet\dotnet.exe'
if(!(Test-Path -LiteralPath $dotnet -PathType Leaf)){throw 'TRUSTED_DOTNET_NOT_FOUND'}
$tempOut=Join-Path $env:TEMP ('ChromeBridge-Recovery-Native-'+[guid]::NewGuid().ToString('N'))
try {
  & $dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $tempOut
  if($LASTEXITCODE -ne 0){throw 'NATIVE_HOST_BUILD_FAILED'}
  $built=Join-Path $tempOut 'ChromeBridge.RecoveryHost.exe'
  if(!(Test-Path -LiteralPath $built -PathType Leaf)){throw 'NATIVE_HOST_NOT_BUILT'}
  New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
  Copy-Item -LiteralPath $built -Destination $exe -ErrorAction Stop
  $hostManifest=[ordered]@{
    name=$hostName
    description='Fixed-action Chrome Bridge local recovery (PR113 lab)'
    path=$exe
    type='stdio'
    allowed_origins=@('chrome-extension://'+$labExtensionId+'/')
  }
  $hostManifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $manifest -Encoding UTF8
  New-Item -Path $regPath -Force | Out-Null
  Set-Item -Path $regPath -Value $manifest
  $hash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  [PSCustomObject]@{
    Result='NATIVE_HOST_REGISTERED'; Host=$hostName
    ExtensionId=$labExtensionId; ExecutableSha256=$hash
    Note='Chrome must reload the extension. No servers were restarted.'
  } | ConvertTo-Json
} finally {
  if(Test-Path -LiteralPath $tempOut){
    Remove-Item -LiteralPath $tempOut -Recurse -Force -ErrorAction SilentlyContinue
  }
}
