$ErrorActionPreference='Stop'
$module=Join-Path (Split-Path $PSScriptRoot -Parent) 'EngineeringCutoverJournal.psm1'
if(!(Test-Path -LiteralPath $module -PathType Leaf)){throw 'JOURNAL_TEST_MODULE_MISSING'}
Import-Module -Name $module -Force -ErrorAction Stop
$root=Join-Path ([IO.Path]::GetTempPath()) ('psdirect-cutover-journal-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
$oldPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$newPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$candidate='1ab5b9098046028eb3b022b91f8e40ca7ff92596'
$script:passed=0
$script:journalTransactions=0

function Assert-True {
 param([bool]$Condition,[string]$Message)
 if(!$Condition){throw ('ASSERTION_FAILED '+$Message)}
 $script:passed++
}
function Assert-Equal {
 param($Actual,$Expected,[string]$Message)
 if($Actual -cne $Expected){throw ('ASSERTION_FAILED '+$Message+' expected='+[string]$Expected+' actual='+[string]$Actual)}
 $script:passed++
}
function Assert-Throws {
 param([scriptblock]$Action,[string]$ExpectedMessage)
 $didThrow=$false
 try { & $Action | Out-Null } catch {
  $didThrow=$true
  if($_.Exception.Message -notlike ('*'+$ExpectedMessage+'*')){
   throw ('ASSERTION_WRONG_ERROR expected='+$ExpectedMessage+' actual='+$_.Exception.Message)
  }
 }
 if(!$didThrow){throw ('ASSERTION_DID_NOT_THROW expected='+$ExpectedMessage)}
 $script:passed++
}
function New-TestJournal {
 $id=[Guid]::NewGuid().ToString('N')
 $created=New-CutoverJournal -JournalDirectory $root -TransactionId $id -OldSupervisorPid 1234 -OldTunnelPid 5678 -OldSupervisorPath $oldPath -NewSupervisorPath $newPath -CandidateCommit $candidate
 $script:journalTransactions++
 return $created
}
function Move-Phase {
 param($Journal,[int]$Sequence,[string]$Phase,[string]$Code='TEST_PHASE')
 return Set-CutoverJournalPhase -JournalPath $Journal.JournalPath -ExpectedSequence $Sequence -Phase $Phase -ResultCode $Code
}
function Set-TestJournalPayload {
 param([string]$JournalPath,[scriptblock]$Mutation)
 $utf8=[System.Text.UTF8Encoding]::new($false)
 $envelope=Get-Content -LiteralPath $JournalPath -Raw | ConvertFrom-Json
 $payloadBytes=[Convert]::FromBase64String([string]$envelope.payloadBase64)
 $payloadText=$utf8.GetString($payloadBytes)
 $payload=ConvertFrom-Json -InputObject $payloadText -ErrorAction Stop
 $null = & $Mutation $payload
 $newPayloadJson=ConvertTo-Json -InputObject $payload -Depth 12 -Compress
 $newPayloadBytes=$utf8.GetBytes($newPayloadJson)
 $sha=[Security.Cryptography.SHA256]::Create()
 try { $newHash=([BitConverter]::ToString($sha.ComputeHash($newPayloadBytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
 $envelope.payloadBase64=[Convert]::ToBase64String($newPayloadBytes)
 $envelope.payloadSha256=$newHash
 $envelopeJson=ConvertTo-Json -InputObject $envelope -Depth 4 -Compress
 [IO.File]::WriteAllText($JournalPath,$envelopeJson,$utf8)
}

try {
 # 1. A new journal is exclusive, checksummed, and contains no credential field.
 $journal=New-TestJournal
 $record=Get-CutoverJournal -JournalPath $journal.JournalPath
 Assert-Equal $record.phase 'CREATED' 'initial phase'
 Assert-Equal $record.status 'IN_PROGRESS' 'initial status'
 Assert-Equal ([int]$record.sequence) 0 'initial sequence'
 Assert-Equal $record.events.Count 1 'initial event count'
 Assert-True ($null -eq $record.PSObject.Properties['credential']) 'no credential field'
 Assert-Throws { New-CutoverJournal -JournalDirectory $root -TransactionId $journal.TransactionId -OldSupervisorPid 1234 -OldTunnelPid 5678 -OldSupervisorPath $oldPath -NewSupervisorPath $newPath -CandidateCommit $candidate } 'JOURNAL_TRANSACTION_ALREADY_EXISTS'

 # 2. Illegal transition and stale sequence must be rejected without mutation.
 Assert-Throws { Move-Phase $journal 0 'COMMITTED' } 'JOURNAL_PHASE_TRANSITION_INVALID'
 Assert-Throws { Move-Phase $journal 4 'PREFLIGHT_VERIFIED' } 'JOURNAL_SEQUENCE_CONFLICT'
 Assert-Throws { Move-Phase $journal 0 'preflight_verified' } 'JOURNAL_PHASE_TRANSITION_INVALID'
 Assert-Throws { Move-Phase $journal 0 'PREFLIGHT_VERIFIED' 'lowercase_result' } 'JOURNAL_RESULT_CODE_INVALID'
 $record=Get-CutoverJournal -JournalPath $journal.JournalPath
 Assert-Equal $record.phase 'CREATED' 'failed transition preserves phase'

 # 3. A locked current file makes atomic replacement fail; old journal stays readable.
 $fileLock=[IO.File]::Open($journal.JournalPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try {
  $didThrow=$false
  try { Move-Phase $journal 0 'PREFLIGHT_VERIFIED' | Out-Null } catch { $didThrow=$true }
  Assert-True $didThrow 'atomic replace must fail while journal is open without delete sharing'
 } finally { $fileLock.Dispose() }
 $record=Get-CutoverJournal -JournalPath $journal.JournalPath
 Assert-Equal $record.phase 'CREATED' 'atomic failure preserves old record'
 $temporary=@(Get-ChildItem -LiteralPath $root -Filter '.cutover-*.tmp' -File -ErrorAction SilentlyContinue)
 Assert-Equal $temporary.Count 0 'failed write removes only its unique temp file'

 # 4. Simulated process interruption after durable intent is manual reconciliation only.
 $null=Move-Phase $journal 0 'PREFLIGHT_VERIFIED'
 $null=Move-Phase $journal 1 'OLD_STOP_INTENT'
 $assessment=Get-CutoverJournalRecoveryAssessment -JournalPath $journal.JournalPath
 Assert-Equal $assessment.RecoveryAction 'MANUAL_RECONCILIATION_REQUIRED_NO_AUTO_REPLAY' 'intent requires manual reconciliation'
 Assert-Equal $assessment.AutomaticActionTaken $false 'assessment never acts'
 Assert-Throws { Move-Phase $journal 1 'OLD_STOPPED' } 'JOURNAL_SEQUENCE_CONFLICT'
 $null=Move-Phase $journal 2 'OLD_STOPPED'
 $null=Move-Phase $journal 3 'NEW_START_INTENT'
 $null=Move-Phase $journal 4 'NEW_STARTED'
 $null=Move-Phase $journal 5 'NEW_HEALTH_VERIFIED'
 $null=Move-Phase $journal 6 'COMMITTED'
 $assessment=Get-CutoverJournalRecoveryAssessment -JournalPath $journal.JournalPath
 Assert-Equal $assessment.RecoveryAction 'TERMINAL_NO_REPLAY' 'committed transaction never replays'
 Assert-Equal $assessment.Status 'COMMITTED' 'committed terminal status'
 Assert-Throws { Move-Phase $journal 7 'ROLLBACK_INTENT' } 'JOURNAL_TERMINAL_NO_TRANSITIONS'

 # 5. Rollback has its own explicit intent/completion path and terminal record.
 $rollback=New-TestJournal
 $null=Move-Phase $rollback 0 'PREFLIGHT_VERIFIED'
 $null=Move-Phase $rollback 1 'OLD_STOP_INTENT'
 $null=Move-Phase $rollback 2 'OLD_STOPPED'
 $null=Move-Phase $rollback 3 'ROLLBACK_INTENT'
 $null=Move-Phase $rollback 4 'REPLACEMENT_STOPPED'
 $null=Move-Phase $rollback 5 'ORIGINAL_RESTORE_INTENT'
 $null=Move-Phase $rollback 6 'ROLLED_BACK'
 $assessment=Get-CutoverJournalRecoveryAssessment -JournalPath $rollback.JournalPath
 Assert-Equal $assessment.RecoveryAction 'TERMINAL_NO_REPLAY' 'rolled-back transaction never replays'
 Assert-Equal $assessment.Status 'ROLLED_BACK' 'rollback terminal status'

 # 6. A concurrent writer fails closed with a stable lock error.
 $locked=New-TestJournal
 $lockStream=[IO.File]::Open($locked.JournalPath+'.lock',[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 try { Assert-Throws { Move-Phase $locked 0 'PREFLIGHT_VERIFIED' } 'JOURNAL_LOCK_BUSY' }
 finally { $lockStream.Dispose() }
 Assert-Equal (Get-CutoverJournal -JournalPath $locked.JournalPath).phase 'CREATED' 'lock contention preserves phase'

 # 7. Payload checksum detects corruption.
 $corrupt=New-TestJournal
 $envelope=Get-Content -LiteralPath $corrupt.JournalPath -Raw | ConvertFrom-Json
 $base64=[string]$envelope.payloadBase64
 $replacement=if($base64[0] -eq 'A'){'B'}else{'A'}
 $envelope.payloadBase64=$replacement+$base64.Substring(1)
 [IO.File]::WriteAllText($corrupt.JournalPath,($envelope|ConvertTo-Json -Compress),[System.Text.UTF8Encoding]::new($false))
 Assert-Throws { Get-CutoverJournal -JournalPath $corrupt.JournalPath } 'JOURNAL_CHECKSUM_MISMATCH'

 # 8. Fractional sequence and noncanonical result codes are rejected even with a valid checksum.
 $fractional=New-TestJournal
 Set-TestJournalPayload -JournalPath $fractional.JournalPath -Mutation { param($payload) $payload.sequence=[double]0.5 }
 Assert-Throws { Get-CutoverJournal -JournalPath $fractional.JournalPath } 'JOURNAL_SEQUENCE_OR_EVENT_COUNT_INVALID'
 Set-TestJournalPayload -JournalPath $fractional.JournalPath -Mutation { param($payload) $payload.sequence=0; $payload.events[0].sequence=[double]0.5 }
 Assert-Throws { Get-CutoverJournal -JournalPath $fractional.JournalPath } 'JOURNAL_EVENT_SEQUENCE_INVALID'
 Set-TestJournalPayload -JournalPath $fractional.JournalPath -Mutation { param($payload) $payload.sequence=0; $payload.events[0].sequence=0; $payload.events[0].resultCode='lowercase_code' }
 Assert-Throws { Get-CutoverJournal -JournalPath $fractional.JournalPath } 'JOURNAL_EVENT_RESULT_CODE_INVALID'

 # 9. A torn/unreadable journal is not repaired or replayed automatically.
 $torn=New-TestJournal
 [IO.File]::WriteAllText($torn.JournalPath,'{"formatVersion":1',[System.Text.UTF8Encoding]::new($false))
 Assert-Throws { Get-CutoverJournal -JournalPath $torn.JournalPath } 'JOURNAL_CORRUPT_OR_UNREADABLE'

 # 10. A failed rollback is terminal and explicitly requires manual intervention.
 $failed=New-TestJournal
 $null=Move-Phase $failed 0 'PREFLIGHT_VERIFIED'
 $null=Move-Phase $failed 1 'OLD_STOP_INTENT'
 $null=Move-Phase $failed 2 'OLD_STOPPED'
 $null=Move-Phase $failed 3 'ROLLBACK_INTENT'
 $null=Move-Phase $failed 4 'ROLLBACK_FAILED'
 $assessment=Get-CutoverJournalRecoveryAssessment -JournalPath $failed.JournalPath
 Assert-Equal $assessment.Status 'FAILED' 'rollback failure status'
 Assert-Equal $assessment.RecoveryAction 'TERMINAL_NO_REPLAY' 'rollback failure does not auto-replay'

 [pscustomobject]@{
  Result='CUTOVER_JOURNAL_TESTS_PASS'
  Assertions=$passed
  JournalTransactions=$script:journalTransactions
  AtomicReplaceVerified=$true
  ChecksumCorruptionDetected=$true
  InterruptedIntentRequiresManualReconciliation=$true
  RollbackTerminalStateVerified=$true
  AutomaticProcessActionTaken=$false
 } | ConvertTo-Json -Depth 4
} finally {
 Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
 Remove-Module EngineeringCutoverJournal -ErrorAction SilentlyContinue
}
