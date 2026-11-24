# Durable, checksummed, atomic cutover transaction journal.
# This module only records state. It never stops/starts processes or tunnels.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CutoverTransitions = @{
  CREATED = @('PREFLIGHT_VERIFIED','ABORTED')
  PREFLIGHT_VERIFIED = @('OLD_STOP_INTENT','ABORTED')
  OLD_STOP_INTENT = @('OLD_STOPPED','STOP_FAILED','UNKNOWN')
  OLD_STOPPED = @('NEW_START_INTENT','ROLLBACK_INTENT','UNKNOWN')
  NEW_START_INTENT = @('NEW_STARTED','START_FAILED','ROLLBACK_INTENT','UNKNOWN')
  NEW_STARTED = @('NEW_HEALTH_VERIFIED','ROLLBACK_INTENT','UNKNOWN')
  NEW_HEALTH_VERIFIED = @('COMMITTED','ROLLBACK_INTENT','UNKNOWN')
  START_FAILED = @('ROLLBACK_INTENT','UNKNOWN')
  STOP_FAILED = @('ABORTED','UNKNOWN')
  ROLLBACK_INTENT = @('REPLACEMENT_STOPPED','ROLLBACK_FAILED','UNKNOWN')
  REPLACEMENT_STOPPED = @('ORIGINAL_RESTORE_INTENT','ROLLBACK_FAILED','UNKNOWN')
  ORIGINAL_RESTORE_INTENT = @('ROLLED_BACK','ROLLBACK_FAILED','UNKNOWN')
  ROLLBACK_FAILED = @()
  COMMITTED = @()
  ROLLED_BACK = @()
  ABORTED = @()
  UNKNOWN = @()
}
$script:TerminalCutoverPhases = @('COMMITTED','ROLLED_BACK','ABORTED','ROLLBACK_FAILED','UNKNOWN')

function Get-CutoverJournalHash {
  param([Parameter(Mandatory=$true)][byte[]]$Bytes)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($Bytes)
    return ([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Assert-CutoverJournalDirectory {
  param([Parameter(Mandatory=$true)][string]$Path)
  if (![IO.Path]::IsPathRooted($Path)) { throw 'JOURNAL_DIRECTORY_MUST_BE_ABSOLUTE' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (!(Test-Path -LiteralPath $full -PathType Container)) { throw 'JOURNAL_DIRECTORY_MISSING' }
  $item = Get-Item -LiteralPath $full -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'JOURNAL_DIRECTORY_REPARSE_POINT_DENIED'
  }
  return $full
}

function Assert-CutoverJournalPath {
  param([Parameter(Mandatory=$true)][string]$JournalPath)
  if (![IO.Path]::IsPathRooted($JournalPath)) { throw 'JOURNAL_PATH_MUST_BE_ABSOLUTE' }
  $full = [IO.Path]::GetFullPath($JournalPath)
  $directory = Assert-CutoverJournalDirectory -Path ([IO.Path]::GetDirectoryName($full))
  $name = [IO.Path]::GetFileName($full)
  if ($name -notmatch '^(?<id>[0-9a-fA-F]{32})\.json$') { throw 'JOURNAL_FILENAME_INVALID' }
  if ([IO.File]::Exists($full)) {
    $attributes = [IO.File]::GetAttributes($full)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'JOURNAL_FILE_REPARSE_POINT_DENIED'
    }
  }
  return [pscustomobject]@{ Path=$full; Directory=$directory; TransactionId=$Matches.id.ToLowerInvariant() }
}

function Enter-CutoverJournalLock {
  param([Parameter(Mandatory=$true)][string]$JournalPath)
  $lockPath = $JournalPath + '.lock'
  if ([IO.File]::Exists($lockPath)) {
    $attributes = [IO.File]::GetAttributes($lockPath)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'JOURNAL_LOCK_REPARSE_POINT_DENIED'
    }
  }
  try {
    return [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  } catch [IO.IOException] {
    throw 'JOURNAL_LOCK_BUSY'
  }
}

function Write-CutoverJournalEnvelope {
  param(
    [Parameter(Mandatory=$true)][string]$JournalPath,
    [Parameter(Mandatory=$true)]$Record,
    [switch]$CreateOnly
  )
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  $payloadJson = ConvertTo-Json -InputObject $Record -Depth 12 -Compress
  $payloadBytes = $utf8.GetBytes($payloadJson)
  $envelope = [ordered]@{
    formatVersion = 1
    payloadBase64 = [Convert]::ToBase64String($payloadBytes)
    payloadSha256 = Get-CutoverJournalHash -Bytes $payloadBytes
  }
  $envelopeJson = ConvertTo-Json -InputObject $envelope -Depth 4 -Compress
  $envelopeBytes = $utf8.GetBytes($envelopeJson)
  $temporaryPath = Join-Path ([IO.Path]::GetDirectoryName($JournalPath)) ('.cutover-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $stream = $null
  try {
    $stream = [IO.File]::Open($temporaryPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $stream.Write($envelopeBytes,0,$envelopeBytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null

    if ($CreateOnly) {
      # File.Move fails when the destination already exists; no overwrite path.
      [IO.File]::Move($temporaryPath,$JournalPath)
    } else {
      if (![IO.File]::Exists($JournalPath)) { throw 'JOURNAL_FILE_MISSING_DURING_UPDATE' }
      # Same-directory atomic replacement only. No non-atomic fallback is allowed.
      [IO.File]::Replace($temporaryPath,$JournalPath,$null)
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ([IO.File]::Exists($temporaryPath)) {
      try { [IO.File]::Delete($temporaryPath) } catch { }
    }
  }
}

function Read-CutoverJournalRecord {
  param([Parameter(Mandatory=$true)][string]$JournalPath)
  $identity = Assert-CutoverJournalPath -JournalPath $JournalPath
  if (![IO.File]::Exists($identity.Path)) { throw 'JOURNAL_FILE_MISSING' }
  try {
    $bytes = [IO.File]::ReadAllBytes($identity.Path)
    $strictUtf8 = [System.Text.UTF8Encoding]::new($false,$true)
    $envelopeText = $strictUtf8.GetString($bytes)
    $envelope = ConvertFrom-Json -InputObject $envelopeText -ErrorAction Stop
    if ($envelope.formatVersion -ne 1) { throw 'JOURNAL_ENVELOPE_VERSION_UNSUPPORTED' }
    $payloadBytes = [Convert]::FromBase64String([string]$envelope.payloadBase64)
    $actualHash = Get-CutoverJournalHash -Bytes $payloadBytes
    if ($actualHash -cne [string]$envelope.payloadSha256) { throw 'JOURNAL_CHECKSUM_MISMATCH' }
    $payloadText = $strictUtf8.GetString($payloadBytes)
    $record = ConvertFrom-Json -InputObject $payloadText -ErrorAction Stop
  } catch {
    if ($_.Exception.Message -match '^JOURNAL_') { throw }
    throw 'JOURNAL_CORRUPT_OR_UNREADABLE'
  }
  if ($record.schemaVersion -ne 1) { throw 'JOURNAL_SCHEMA_UNSUPPORTED' }
  if ([string]$record.transactionId -cne $identity.TransactionId) { throw 'JOURNAL_TRANSACTION_ID_MISMATCH' }
  if (!$script:CutoverTransitions.ContainsKey([string]$record.phase)) { throw 'JOURNAL_PHASE_INVALID' }
  if ([int]$record.sequence -lt 0 -or @($record.events).Count -ne ([int]$record.sequence + 1)) {
    throw 'JOURNAL_SEQUENCE_OR_EVENT_COUNT_INVALID'
  }
  if ([string]$record.status -cne (Get-CutoverJournalStatus -Phase ([string]$record.phase))) {
    throw 'JOURNAL_STATUS_PHASE_MISMATCH'
  }
  $history = @($record.events)
  for ($index=0; $index -lt $history.Count; $index++) {
    if ([int]$history[$index].sequence -ne $index) { throw 'JOURNAL_EVENT_SEQUENCE_INVALID' }
    if ([string]$history[$index].resultCode -notmatch '^[A-Z0-9_]{1,64}
}

function Get-CutoverJournalStatus {
  param([Parameter(Mandatory=$true)][string]$Phase)
  switch ($Phase) {
    'COMMITTED' { return 'COMMITTED' }
    'ROLLED_BACK' { return 'ROLLED_BACK' }
    'ABORTED' { return 'ABORTED' }
    'ROLLBACK_FAILED' { return 'FAILED' }
    'STOP_FAILED' { return 'FAILED' }
    'START_FAILED' { return 'FAILED' }
    'UNKNOWN' { return 'UNKNOWN' }
    default { return 'IN_PROGRESS' }
  }
}

function New-CutoverJournal {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$JournalDirectory,
    [Parameter(Mandatory=$true)][string]$TransactionId,
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OldSupervisorPid,
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OldTunnelPid,
    [Parameter(Mandatory=$true)][string]$OldSupervisorPath,
    [Parameter(Mandatory=$true)][string]$NewSupervisorPath,
    [Parameter(Mandatory=$true)][string]$CandidateCommit
  )
  $directory = Assert-CutoverJournalDirectory -Path $JournalDirectory
  if ($CandidateCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'JOURNAL_CANDIDATE_COMMIT_INVALID' }
  $parsedGuid = [Guid]::Empty
  if (![Guid]::TryParseExact($TransactionId,'N',[ref]$parsedGuid)) { throw 'JOURNAL_TRANSACTION_ID_INVALID' }
  foreach ($path in @($OldSupervisorPath,$NewSupervisorPath)) {
    if ([string]::IsNullOrWhiteSpace($path) -or ![IO.Path]::IsPathRooted($path)) {
      throw 'JOURNAL_STACK_PATH_INVALID'
    }
  }
  $id = $parsedGuid.ToString('N')
  $journalPath = Join-Path $directory ($id + '.json')
  if ([IO.File]::Exists($journalPath)) { throw 'JOURNAL_TRANSACTION_ALREADY_EXISTS' }

  $now = [DateTime]::UtcNow.ToString('o')
  $initialEvent = [ordered]@{ sequence=0; phase='CREATED'; resultCode='TRANSACTION_CREATED'; atUtc=$now }
  $record = [ordered]@{
    schemaVersion = 1
    transactionId = $id
    createdAtUtc = $now
    updatedAtUtc = $now
    sequence = 0
    phase = 'CREATED'
    status = 'IN_PROGRESS'
    candidateCommit = $CandidateCommit.ToLowerInvariant()
    oldStack = [ordered]@{
      supervisorPid = $OldSupervisorPid
      tunnelPid = $OldTunnelPid
      supervisorPath = [IO.Path]::GetFullPath($OldSupervisorPath)
    }
    newStack = [ordered]@{
      supervisorPath = [IO.Path]::GetFullPath($NewSupervisorPath)
      supervisorPid = $null
      tunnelPid = $null
    }
    events = @($initialEvent)
  }
  $lock = Enter-CutoverJournalLock -JournalPath $journalPath
  try {
    Write-CutoverJournalEnvelope -JournalPath $journalPath -Record $record -CreateOnly
  } finally {
    $lock.Dispose()
  }
  return [pscustomobject]@{ JournalPath=$journalPath; TransactionId=$id; Sequence=0; Phase='CREATED'; Status='IN_PROGRESS' }
}

function Get-CutoverJournal {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$JournalPath)
  return Read-CutoverJournalRecord -JournalPath $JournalPath
}

function Set-CutoverJournalPhase {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$JournalPath,
    [Parameter(Mandatory=$true)][ValidateRange(0,2147483646)][int]$ExpectedSequence,
    [Parameter(Mandatory=$true)][ValidateSet(
      'PREFLIGHT_VERIFIED','OLD_STOP_INTENT','OLD_STOPPED','STOP_FAILED',
      'NEW_START_INTENT','NEW_STARTED','START_FAILED','NEW_HEALTH_VERIFIED',
      'ROLLBACK_INTENT','REPLACEMENT_STOPPED','ORIGINAL_RESTORE_INTENT',
      'COMMITTED','ROLLED_BACK','ROLLBACK_FAILED','ABORTED','UNKNOWN'
    )][string]$Phase,
    [Parameter(Mandatory=$true)][string]$ResultCode
  )
  if ($ResultCode -notmatch '^[A-Z0-9_]{1,64}$') { throw 'JOURNAL_RESULT_CODE_INVALID' }
  $identity = Assert-CutoverJournalPath -JournalPath $JournalPath
  $lock = Enter-CutoverJournalLock -JournalPath $identity.Path
  try {
    $record = Read-CutoverJournalRecord -JournalPath $identity.Path
    if ([int]$record.sequence -ne $ExpectedSequence) { throw 'JOURNAL_SEQUENCE_CONFLICT' }
    if ($script:TerminalCutoverPhases -contains [string]$record.phase) { throw 'JOURNAL_TERMINAL_NO_TRANSITIONS' }
    $allowed = @($script:CutoverTransitions[[string]$record.phase])
    if ($allowed -notcontains $Phase) { throw 'JOURNAL_PHASE_TRANSITION_INVALID' }

    $nextSequence = [int]$record.sequence + 1
    $now = [DateTime]::UtcNow.ToString('o')
    $event = [ordered]@{ sequence=$nextSequence; phase=$Phase; resultCode=$ResultCode; atUtc=$now }
    $record.sequence = $nextSequence
    $record.phase = $Phase
    $record.status = Get-CutoverJournalStatus -Phase $Phase
    $record.updatedAtUtc = $now
    $record.events = @($record.events) + @($event)
    Write-CutoverJournalEnvelope -JournalPath $identity.Path -Record $record
    return [pscustomobject]@{
      JournalPath=$identity.Path
      TransactionId=[string]$record.transactionId
      Sequence=$nextSequence
      Phase=$Phase
      Status=[string]$record.status
    }
  } finally {
    $lock.Dispose()
  }
}

function Get-CutoverJournalRecoveryAssessment {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$JournalPath)
  $record = Read-CutoverJournalRecord -JournalPath $JournalPath
  $phase = [string]$record.phase
  if ($script:TerminalCutoverPhases -contains $phase) {
    $action = 'TERMINAL_NO_REPLAY'
  } elseif ($phase -in @('CREATED','PREFLIGHT_VERIFIED')) {
    $action = 'SAFE_TO_ABORT_NO_DESTRUCTIVE_INTENT_RECORDED'
  } else {
    $action = 'MANUAL_RECONCILIATION_REQUIRED_NO_AUTO_REPLAY'
  }
  return [pscustomobject]@{
    TransactionId=[string]$record.transactionId
    Sequence=[int]$record.sequence
    Phase=$phase
    Status=[string]$record.status
    RecoveryAction=$action
    AutomaticActionTaken=$false
  }
}

Export-ModuleMember -Function New-CutoverJournal,Get-CutoverJournal,Set-CutoverJournalPhase,Get-CutoverJournalRecoveryAssessment
