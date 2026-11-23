# Read-only PR102 Lab runtime identity report. Never emits config/token values.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$labRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$labPort=17484
$candidateRoot='C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\ChromeBridge-PR132-42ccb6de-release-clean\docs\chrome-bridge-handoff\chrome-bridge-v20'
if(!(Test-Path -LiteralPath $labRoot -PathType Container)){throw 'LAB_ROOT_NOT_FOUND'}
. (Join-Path $candidateRoot 'deployment\process-identity.ps1')
$listeners=@([BridgeNativeMetadata]::Listeners($labPort))
if($listeners.Count -ne 1){throw ('LAB_LISTENER_COUNT_MISMATCH: '+$listeners.Count)}
$parts=([string]$listeners[0]).Split('|')
if($parts.Count -ne 2 -or $parts[0] -cne '127.0.0.1'){throw 'LAB_LISTENER_ADDRESS_MISMATCH'}
$pidValue=0
if(![int]::TryParse($parts[1],[ref]$pidValue)){throw 'LAB_LISTENER_PID_INVALID'}
if(-not ('BridgeProcessEnvironment' -as [type])){
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BridgeProcessEnvironment {
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public UIntPtr UniqueProcessId;
    public UIntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr processHandle,int infoClass,out PROCESS_BASIC_INFORMATION info,int length,out int returned);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] buffer,IntPtr size,out IntPtr read);
  static IntPtr ReadPointer(IntPtr h,IntPtr address){
    byte[] b=new byte[IntPtr.Size];IntPtr read;
    if(!ReadProcessMemory(h,address,b,(IntPtr)b.Length,out read)||(long)read!=b.Length)throw new Exception("PEB_POINTER_READ_FAILED");
    return IntPtr.Size==8?new IntPtr(BitConverter.ToInt64(b,0)):new IntPtr(BitConverter.ToInt32(b,0));
  }
  static byte[] ReadExact(IntPtr h,IntPtr address,int length){
    byte[] b=new byte[length];IntPtr read;
    if(!ReadProcessMemory(h,address,b,(IntPtr)length,out read)||(long)read!=length)throw new Exception("PEB_STRING_READ_FAILED");
    return b;
  }
  public static string[] ReadSelected(IntPtr h){
    PROCESS_BASIC_INFORMATION basic;int returned;
    int status=NtQueryInformationProcess(h,0,out basic,Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),out returned);
    if(status!=0||basic.PebBaseAddress==IntPtr.Zero)throw new Exception("PEB_QUERY_FAILED");
    IntPtr parameters=ReadPointer(h,IntPtr.Add(basic.PebBaseAddress,0x20));
    if(parameters==IntPtr.Zero)throw new Exception("PROCESS_PARAMETERS_MISSING");
    byte[] cwdDescriptor=ReadExact(h,IntPtr.Add(parameters,0x38),IntPtr.Size==8?16:8);
    int cwdLength=BitConverter.ToUInt16(cwdDescriptor,0);
    IntPtr cwdBuffer=IntPtr.Size==8?new IntPtr(BitConverter.ToInt64(cwdDescriptor,8)):new IntPtr(BitConverter.ToInt32(cwdDescriptor,4));
    string cwd=(cwdLength>0&&cwdLength<32768&&cwdBuffer!=IntPtr.Zero)?Encoding.Unicode.GetString(ReadExact(h,cwdBuffer,cwdLength)):"";
    IntPtr env=ReadPointer(h,IntPtr.Add(parameters,IntPtr.Size==8?0x80:0x48));
    if(env==IntPtr.Zero)throw new Exception("PROCESS_ENVIRONMENT_MISSING");
    using(MemoryStream stream=new MemoryStream()){
      bool done=false;
      for(int offset=0;offset<1048576&&!done;offset+=4096){
        byte[] chunk=new byte[4096];IntPtr got;
        if(!ReadProcessMemory(h,IntPtr.Add(env,offset),chunk,(IntPtr)chunk.Length,out got)){
          if((long)got<=0)throw new Exception("PROCESS_ENVIRONMENT_READ_FAILED");
        }
        int count=(int)got;if(count<=0)break;
        stream.Write(chunk,0,count);
        byte[] all=stream.ToArray();
        for(int i=0;i+3<all.Length;i+=2){
          if(all[i]==0&&all[i+1]==0&&all[i+2]==0&&all[i+3]==0){done=true;break;}
        }
        if(count<chunk.Length)break;
      }
      string[] entries=Encoding.Unicode.GetString(stream.ToArray()).Split(new char[]{'\0'},StringSplitOptions.RemoveEmptyEntries);
      var selected=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      foreach(string entry in entries){
        int eq=entry.IndexOf('=');if(eq<=0)continue;
        string key=entry.Substring(0,eq);
        if(key.Equals("CHROME_BRIDGE_HOME",StringComparison.OrdinalIgnoreCase)||
           key.Equals("CHROME_BRIDGE_PORT",StringComparison.OrdinalIgnoreCase)||
           key.Equals("CHROME_BRIDGE_EXTENSION_ID",StringComparison.OrdinalIgnoreCase))
          selected[key]=entry.Substring(eq+1);
      }
      string home=selected.ContainsKey("CHROME_BRIDGE_HOME")?selected["CHROME_BRIDGE_HOME"]:"";
      string port=selected.ContainsKey("CHROME_BRIDGE_PORT")?selected["CHROME_BRIDGE_PORT"]:"";
      string ext=selected.ContainsKey("CHROME_BRIDGE_EXTENSION_ID")?selected["CHROME_BRIDGE_EXTENSION_ID"]:"";
      return new string[]{cwd,home,port,ext};
    }
  }
}
'@
}
$proc=[Diagnostics.Process]::GetProcessById($pidValue)
try{
  $identity=Get-BridgeHandleIdentity $proc
  $selectedEnvironment=[BridgeProcessEnvironment]::ReadSelected($proc.Handle)
}finally{$proc.Dispose()}
$processCwd=[string]$selectedEnvironment[0]
$processHome=[string]$selectedEnvironment[1]
$processPort=[string]$selectedEnvironment[2]
$processExtensionId=[string]$selectedEnvironment[3]
$command=[string]$identity.command
$safeCommand=$command
$safeCommand=[regex]::Replace($safeCommand,'(?i)(bearer\s+)[A-Za-z0-9._~+/-]{16,}','$1[REDACTED]')
$safeCommand=[regex]::Replace($safeCommand,'(?i)((?:token|secret|password|api[_-]?key)(?:\s+|=|:))("[^"]+"|\S+)','$1[REDACTED]')
$safeCommand=[regex]::Replace($safeCommand,'(?i)\b(?:[a-f0-9]{40,}|[A-Za-z0-9_-]{48,})\b','[REDACTED]')
if($safeCommand.Length -gt 1200){$safeCommand=$safeCommand.Substring(0,1200)+'...[TRUNCATED]'}
$bridgePath=(Join-Path $labRoot 'server\bridge.mjs')
$configReports=@()
$configFiles=@(Get-ChildItem -LiteralPath $labRoot -Filter 'config.json' -File -Recurse -Force -ErrorAction Stop)
foreach($file in $configFiles){
  try{
    $cfg=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json
    $relative=$file.FullName.Substring($labRoot.Length).TrimStart('\')
    $configReports += [pscustomobject]@{
      RelativePath=$relative
      Sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      AgentTokenLength=if($cfg.agentToken -is [string]){$cfg.agentToken.Length}else{0}
      BrowserTokenLength=if($cfg.browserToken -is [string]){$cfg.browserToken.Length}else{0}
      HasExtensionId=($null -ne $cfg.PSObject.Properties['extensionId'])
      ExtensionIdMatches=([string]$cfg.extensionId -ceq 'nhflbnfcaicihaepdcjacdmaddagcmcj')
      PropertyNames=@($cfg.PSObject.Properties.Name)
    }
  }catch{
    $relative=$file.FullName.Substring($labRoot.Length).TrimStart('\')
    $configReports += [pscustomobject]@{RelativePath=$relative;ParseError=$_.Exception.Message}
  }
}
$parent=$null
try{
  $processRecord=Get-CimInstance Win32_Process -Filter ("ProcessId="+$identity.id)
  $ppid=[int]$processRecord.ParentProcessId
  $parentRecord=Get-CimInstance Win32_Process -Filter ("ProcessId="+$ppid)
  $parentCommand=[string]$parentRecord.CommandLine
  $parentCommand=[regex]::Replace($parentCommand,'(?i)(bearer\s+)[A-Za-z0-9._~+/-]{16,}','$1[REDACTED]')
  $parentCommand=[regex]::Replace($parentCommand,'(?i)((?:token|secret|password|api[_-]?key)(?:\s+|=|:))("[^"]+"|\S+)','$1[REDACTED]')
  $parentCommand=[regex]::Replace($parentCommand,'(?i)\b(?:[a-f0-9]{40,}|[A-Za-z0-9_-]{48,})\b','[REDACTED]')
  if($parentCommand.Length -gt 1600){$parentCommand=$parentCommand.Substring(0,1600)+'...[TRUNCATED]'}
  $parent=[pscustomobject]@{
    ProcessId=$ppid
    ExecutablePath=[string]$parentRecord.ExecutablePath
    CommandLine=$parentCommand
  }
}catch{}
$stateRoot=if(-not [string]::IsNullOrWhiteSpace($processHome)){$processHome}else{Join-Path $env:USERPROFILE '.chrome-bridge'}
$resolvedConfigPath=Join-Path $stateRoot 'config.json'
$actualConfig=$null
if(Test-Path -LiteralPath $resolvedConfigPath -PathType Leaf){
  try{
    $actualCfg=Get-Content -LiteralPath $resolvedConfigPath -Raw -Encoding UTF8|ConvertFrom-Json
    $insideLab=$false
    $normalizedState=[IO.Path]::GetFullPath($stateRoot).TrimEnd('\')
    $normalizedLab=[IO.Path]::GetFullPath($labRoot).TrimEnd('\')
    $insideLab=$normalizedState.StartsWith(($normalizedLab+'\'),[StringComparison]::OrdinalIgnoreCase) -or
      $normalizedState -ieq $normalizedLab
    $actualConfig=[pscustomobject]@{
      ConfigPath=$resolvedConfigPath
      Sha256=(Get-FileHash -LiteralPath $resolvedConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
      AgentTokenLength=if($actualCfg.agentToken -is [string]){$actualCfg.agentToken.Length}else{0}
      BrowserTokenLength=if($actualCfg.browserToken -is [string]){$actualCfg.browserToken.Length}else{0}
      HasExtensionId=($null -ne $actualCfg.PSObject.Properties['extensionId'])
      ExtensionId=if($null -ne $actualCfg.PSObject.Properties['extensionId']){[string]$actualCfg.extensionId}else{''}
      ExtensionIdMatches=if($null -ne $actualCfg.PSObject.Properties['extensionId']){([string]$actualCfg.extensionId -ceq 'nhflbnfcaicihaepdcjacdmaddagcmcj')}else{$false}
      PropertyNames=@($actualCfg.PSObject.Properties.Name)
      StateRootInsideLab=$insideLab
    }
  }catch{$actualConfig=[pscustomobject]@{ConfigPath=$resolvedConfigPath;ParseError=$_.Exception.Message}}
}

$gitExe='C:\Program Files\Git\cmd\git.exe'
function ReadGitValue([string[]]$Arguments){
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$gitExe
  $quoted=@($Arguments|ForEach-Object { '"'+($_.Replace('"','\"'))+'"' })
  $psi.Arguments=[string]::Join(' ',$quoted)
  $psi.WorkingDirectory=$processCwd
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $p=New-Object System.Diagnostics.Process
  $p.StartInfo=$psi
  try{
    if(!$p.Start()){return ''}
    $out=$p.StandardOutput.ReadToEnd();$err=$p.StandardError.ReadToEnd()
    $p.WaitForExit()
    if($p.ExitCode -ne 0){return ''}
    return $out.Trim()
  }finally{$p.Dispose()}
}
$currentRepoRoot=ReadGitValue @('-C',$processCwd,'rev-parse','--show-toplevel')
$currentRepoHead=ReadGitValue @('-C',$processCwd,'rev-parse','HEAD')
$activeTree=[pscustomobject]@{
  Root=$processCwd
  BridgeExists=(Test-Path -LiteralPath (Join-Path $processCwd 'server\bridge.mjs') -PathType Leaf)
  ToolsRegistryExists=(Test-Path -LiteralPath (Join-Path $processCwd 'server\tools.mjs') -PathType Leaf)
  ExtensionDirectoryExists=(Test-Path -LiteralPath (Join-Path $processCwd 'extension') -PathType Container)
  ExtensionManifestExists=(Test-Path -LiteralPath (Join-Path $processCwd 'extension\manifest.json') -PathType Leaf)
  PackageTemplateExists=(Test-Path -LiteralPath (Join-Path $processCwd 'package.json.template') -PathType Leaf)
}
$chromeProfileMatches=@()
$chromeUserData=Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
if(Test-Path -LiteralPath $chromeUserData -PathType Container){
  $idsToFind=@('nhflbnfcaicihaepdcjacdmaddagcmcj')
  if($actualConfig -and $actualConfig.PSObject.Properties['ExtensionId'] -and -not [string]::IsNullOrWhiteSpace([string]$actualConfig.ExtensionId)){
    $idsToFind += [string]$actualConfig.ExtensionId
  }
  foreach($profile in Get-ChildItem -LiteralPath $chromeUserData -Directory -Force | Where-Object {$_.Name -eq 'Default' -or $_.Name -match '^Profile \d+$'}){
    foreach($extensionId in ($idsToFind|Select-Object -Unique)){
      $extensionRoot=Join-Path $profile.FullName ('Extensions\'+$extensionId)
      if(Test-Path -LiteralPath $extensionRoot -PathType Container){
        $chromeProfileMatches += [pscustomobject]@{Profile=$profile.Name;ExtensionId=$extensionId;Installed=$true}
      }
    }
  }
}
$stateRootItem=if(Test-Path -LiteralPath $stateRoot){Get-Item -LiteralPath $stateRoot -Force}else{$null}
$targetLabRoot='C:\Engineering\ChromeBridge-PR102-17484-Lab'
$targetServerExists=Test-Path -LiteralPath (Join-Path $targetLabRoot 'server\bridge.mjs') -PathType Leaf
$targetExtensionManifest=Join-Path $targetLabRoot 'extension\manifest.json'
$targetManifestExists=Test-Path -LiteralPath $targetExtensionManifest -PathType Leaf
$targetExtensionId=''
if($targetManifestExists){
  try{
    $targetManifest=Get-Content -LiteralPath $targetExtensionManifest -Raw -Encoding UTF8|ConvertFrom-Json
    if($targetManifest.PSObject.Properties['key']){
      $targetExtensionId='MANIFEST_KEY_PRESENT'
    }
  }catch{}
}

$idsToFind=@('nhflbnfcaicihaepdcjacdmaddagcmcj')
if(-not [string]::IsNullOrWhiteSpace($processExtensionId)){$idsToFind += $processExtensionId}
if($actualConfig -and $actualConfig.PSObject.Properties['ExtensionId'] -and -not [string]::IsNullOrWhiteSpace([string]$actualConfig.ExtensionId)){
  $idsToFind += [string]$actualConfig.ExtensionId
}
$chromeLoadEvidence=@()
try{
  $chromeProcesses=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'")
  foreach($chromeProcess in $chromeProcesses){
    $line=[string]$chromeProcess.CommandLine
    if([string]::IsNullOrWhiteSpace($line)){continue}
    $userDataMatch=[regex]::Match($line,'(?i)--user-data-dir=(?:"(?<v>[^"]+)"|(?<v>\S+))')
    $profileMatch=[regex]::Match($line,'(?i)--profile-directory=(?:"(?<v>[^"]+)"|(?<v>\S+))')
    $loadMatch=[regex]::Match($line,'(?i)--load-extension=(?:"(?<v>[^"]+)"|(?<v>\S+))')
    $exceptMatch=[regex]::Match($line,'(?i)--disable-extensions-except=(?:"(?<v>[^"]+)"|(?<v>\S+))')
    if($userDataMatch.Success -or $profileMatch.Success -or $loadMatch.Success -or $exceptMatch.Success){
      $dataRoot=if($userDataMatch.Success){$userDataMatch.Groups['v'].Value}else{$chromeUserData}
      $profileName=if($profileMatch.Success){$profileMatch.Groups['v'].Value}else{'Default'}
      $profileRoot=Join-Path $dataRoot $profileName
      $installedIds=@()
      foreach($extensionId in ($idsToFind|Select-Object -Unique)){
        if(Test-Path -LiteralPath (Join-Path $profileRoot ('Extensions\'+$extensionId)) -PathType Container){$installedIds += $extensionId}
      }
      $loadPaths=@()
      if($loadMatch.Success){
        foreach($loadPath in ($loadMatch.Groups['v'].Value -split ',')){
          $loadPaths += [pscustomobject]@{
            Path=$loadPath
            ManifestExists=(Test-Path -LiteralPath (Join-Path $loadPath 'manifest.json') -PathType Leaf)
          }
        }
      }
      $chromeLoadEvidence += [pscustomobject]@{
        ProcessId=$chromeProcess.ProcessId
        UserDataRoot=$dataRoot
        Profile=$profileName
        InstalledExpectedOrActiveIds=$installedIds
        LoadExtensionPaths=$loadPaths
        HasDisableExtensionsExcept=$exceptMatch.Success
      }
    }
  }
}catch{}
$chromeExtensionSettings=@()
$defaultProfile=Join-Path $chromeUserData 'Default'
foreach($prefsName in @('Preferences','Secure Preferences')){
  $prefsPath=Join-Path $defaultProfile $prefsName
  if(Test-Path -LiteralPath $prefsPath -PathType Leaf){
    try{
      $prefs=Get-Content -LiteralPath $prefsPath -Raw -Encoding UTF8|ConvertFrom-Json
      $settings=$prefs.extensions.settings
      if($settings){
        foreach($extensionId in ($idsToFind|Select-Object -Unique)){
          $entry=$settings.PSObject.Properties[$extensionId]
          if($entry){
            $value=$entry.Value
            $chromeExtensionSettings += [pscustomobject]@{
              PreferencesFile=$prefsName
              ExtensionId=$extensionId
              Path=if($value.PSObject.Properties['path']){[string]$value.path}else{''}
              State=if($value.PSObject.Properties['state']){[string]$value.state}else{''}
              Location=if($value.PSObject.Properties['location']){[string]$value.location}else{''}
              FromWebStore=if($value.PSObject.Properties['from_webstore']){[bool]$value.from_webstore}else{$false}
            }
          }
        }
      }
    }catch{}
  }
}

$productionListener=@([BridgeNativeMetadata]::Listeners(17381))
$productionOwner=$null
if($productionListener.Count -eq 1){
  $prodParts=([string]$productionListener[0]).Split('|')
  $prodPid=0
  if($prodParts.Count -eq 2 -and [int]::TryParse($prodParts[1],[ref]$prodPid)){
    try{
      $prodProc=[Diagnostics.Process]::GetProcessById($prodPid)
      try{
        $prodIdentity=Get-BridgeHandleIdentity $prodProc
        $prodEnv=[BridgeProcessEnvironment]::ReadSelected($prodProc.Handle)
        $prodHome=[string]$prodEnv[1]
        $productionOwner=[pscustomobject]@{
          Listener=$productionListener[0]
          ProcessId=$prodPid
          Executable=$prodIdentity.executable
          WorkingDirectory=[string]$prodEnv[0]
          BridgeHome=$prodHome
          BridgePort=[string]$prodEnv[2]
          SharesLabState=([IO.Path]::GetFullPath($(if($prodHome){$prodHome}else{Join-Path $env:USERPROFILE '.chrome-bridge'})).TrimEnd('\') -ieq [IO.Path]::GetFullPath($stateRoot).TrimEnd('\'))
        }
      }finally{$prodProc.Dispose()}
    }catch{$productionOwner=[pscustomobject]@{Listener=$productionListener[0];Error=$_.Exception.Message}}
  }
}

[pscustomobject]@{
  Result='PR102_LAB_RUNTIME_IDENTITY_READ_ONLY'
  Listener=$listeners[0]
  ProcessId=$identity.id
  ProcessCreatedUtc=$identity.created
  Executable=$identity.executable
  Parent=$parent
  CommandLength=$command.Length
  CommandSha256=( [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($command)) | ForEach-Object ToString x2 ) -join ''
  CommandHasLabBridge=($command.IndexOf($bridgePath,[StringComparison]::OrdinalIgnoreCase) -ge 0)
  CommandHasCutoverStart=($command -match '(?i)cutover-start\.mjs')
  CommandHasStartJob=($command -match '(?i)start-[0-9a-f]{32}\.json')
  CommandRedacted=$safeCommand
  ConfigFiles=$configReports
  ProcessWorkingDirectory=$processCwd
  CurrentRepoRoot=$currentRepoRoot
  CurrentRepoHead=$currentRepoHead
  TargetLabServerExists=$targetServerExists
  TargetLabExtensionManifestExists=$targetManifestExists
  TargetLabExtensionKey=$targetExtensionId
  ProcessBridgeHome=$processHome
  ProcessBridgePort=$processPort
  ProcessExtensionIdPresent=(![string]::IsNullOrWhiteSpace($processExtensionId))
  ProcessExtensionIdMatches=($processExtensionId -ceq 'nhflbnfcaicihaepdcjacdmaddagcmcj')
  ActiveSourceTree=$activeTree
  ChromeProfileExtensionMatches=$chromeProfileMatches
  ChromeProcessLoadEvidence=$chromeLoadEvidence
  ChromePreferenceExtensionSettings=$chromeExtensionSettings
  ProductionProcessIdentity=$productionOwner
  EffectiveStateRoot=$stateRoot
  StateRootIsReparsePoint=if($stateRootItem){[bool]($stateRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)}else{$false}
  EffectiveConfig=$actualConfig
  ProductionPathsTouched=$false
  CredentialsPrinted=$false
}|ConvertTo-Json -Depth 8
