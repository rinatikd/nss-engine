# Generates a proposed Task Scheduler command. Does NOT install or run anything.
$script = Join-Path $PSScriptRoot 'Run-MockWorker.ps1'
Write-Output 'Review this optional five-minute scheduler command; use only after approval:'
Write-Output "schtasks /Create /SC MINUTE /MO 5 /TN AI-Coordination-Mock /TR `"powershell.exe -NoProfile -File `"`"$script`"`"`" /F"
Write-Output 'IMPORTANT: This creates only MOCK scheduling. It does NOT run Claude or publish to GitHub.'
