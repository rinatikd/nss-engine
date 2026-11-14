# One-click local launcher for the existing protected Engineering MCP approval page.
# No credentials, DPAPI ciphertext, approval URL or UI token in the shortcut.
# Inspect makes no changes; Install and Remove are explicit user-only mutations.
[CmdletBinding()]
param(
 [ValidateSet('Inspect','Install','Remove')][string]$Mode='Inspect'
)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_REQUIRED'}
$stage='C:\Engineering\PowerShellDirect-Engineering-Lab-R1'
$approval=Join-Path $stage 'tools\powershell-direct\Open-Approval.ps1'
$psExe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$desktop=[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
if([string]::IsNullOrWhiteSpace($desktop) -or !(Test-Path -LiteralPath $desktop -PathType Container)){
 throw 'DESKTOP_NOT_AVAILABLE'
}
$shortcut=Join-Path $desktop 'Engineering MCP Approval.lnk'
if(!(Test-Path -LiteralPath $psExe -PathType Leaf)){throw 'POWERSHELL_NOT_FOUND'}
if(!(Test-Path -LiteralPath $approval -PathType Leaf)){throw 'APPROVAL_LAUNCHER_NOT_INSTALLED'}
$arguments='-NoProfile -File "'+$approval+'"'
$shell=New-Object -ComObject WScript.Shell
function Get-ShortcutState {
 if(!(Test-Path -LiteralPath $shortcut -PathType Leaf)){return 'ABSENT'}
 $existing=$shell.CreateShortcut($shortcut)
 if($existing.TargetPath -ine $psExe -or $existing.Arguments -cne $arguments){
  return 'FOREIGN_OR_CHANGED'
 }
 return 'INSTALLED'
}
$state=Get-ShortcutState
if($Mode -eq 'Install'){
 if($state -eq 'FOREIGN_OR_CHANGED'){throw 'SHORTCUT_CONFLICT_REFUSED'}
 if($state -eq 'ABSENT'){
  $link=$shell.CreateShortcut($shortcut)
  $link.TargetPath=$psExe
  $link.Arguments=$arguments
  $link.WorkingDirectory=$stage
  $link.Description='Open Engineering MCP local operator approval (protected DPAPI token)'
  $link.IconLocation=$psExe+',0'
  $link.Save()
 }
 if((Get-ShortcutState) -ne 'INSTALLED'){throw 'SHORTCUT_INSTALL_NOT_VERIFIED'}
}elseif($Mode -eq 'Remove'){
 if($state -eq 'FOREIGN_OR_CHANGED'){throw 'SHORTCUT_CONFLICT_REFUSED'}
 if($state -eq 'INSTALLED'){Remove-Item -LiteralPath $shortcut -Force}
 if((Get-ShortcutState) -ne 'ABSENT'){throw 'SHORTCUT_REMOVE_NOT_VERIFIED'}
}
[pscustomobject]@{
 Result=if($Mode -eq 'Install'){'APPROVAL_SHORTCUT_INSTALLED'}elseif($Mode -eq 'Remove'){'APPROVAL_SHORTCUT_REMOVED'}else{'APPROVAL_SHORTCUT_INSPECTED'}
 State=Get-ShortcutState
 ShortcutPath=$shortcut
 SecretStoredInShortcut=$false
 ProductionServiceTouched=$false
}|ConvertTo-Json
