[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("backup", "restore", "verify")]
  [string]$Action,
  [string]$BackupPath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$DataDir = Join-Path $env:USERPROFILE ".automaton"
$ConfigPath = Join-Path $DataDir "automaton.json"

function Write-Status([string]$Message) {
  Write-Host "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')] $Message"
}

function Resolve-DatabasePath([string]$SourceConfigPath = $ConfigPath) {
  if (-not (Test-Path -LiteralPath $SourceConfigPath -PathType Leaf)) {
    return (Join-Path $DataDir "state.db")
  }
  $config = Get-Content -Raw -LiteralPath $SourceConfigPath | ConvertFrom-Json
  $configuredPath = [string]$config.dbPath
  if ([string]::IsNullOrWhiteSpace($configuredPath)) { return (Join-Path $DataDir "state.db") }
  if ($configuredPath.StartsWith("~/") -or $configuredPath.StartsWith("~\")) {
    return Join-Path $env:USERPROFILE $configuredPath.Substring(2).Replace("/", "\")
  }
  return [System.IO.Path]::GetFullPath($configuredPath.Replace("%USERPROFILE%", $env:USERPROFILE))
}

function Invoke-DatabaseCheck([string]$DatabasePath, [string]$DestinationPath = "") {
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw "Database not found: $DatabasePath"
  }
  Push-Location $ProjectRoot
  try {
    if ($DestinationPath) {
      $script = 'import Database from "better-sqlite3"; const db=new Database(process.argv[1],{readonly:true,fileMustExist:true}); try { await db.backup(process.argv[2]); } finally { db.close(); }'
      & node --input-type=module -e $script $DatabasePath $DestinationPath
    } else {
      $script = 'import Database from "better-sqlite3"; const db=new Database(process.argv[1],{readonly:true,fileMustExist:true}); try { const r=db.pragma("integrity_check",{simple:true}); if(r!=="ok"){console.error(r);process.exitCode=1;} else {console.log("SQLite integrity_check: ok");} } finally { db.close(); }'
      & node --input-type=module -e $script $DatabasePath
    }
    if ($LASTEXITCODE -ne 0) { throw "SQLite backup or integrity verification failed (exit $LASTEXITCODE)." }
  }
  finally { Pop-Location }
}

function ConvertTo-PlainText([System.Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Quote-ProcessArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-BackupCrypto([string]$Operation, [string]$InputPath, [string]$OutputPath = "") {
  $helper = Join-Path $ProjectRoot "dist/windows/backup-crypto.js"
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "Backup encryption helper is missing. From the repository folder, run 'pnpm build' and retry."
  }
  $arguments = @($helper, $Operation, $InputPath)
  if ($OutputPath) { $arguments += $OutputPath }
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = (Get-Command node -ErrorAction Stop).Source
  $processInfo.Arguments = (($arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join " ")
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $securePassphrase = $null
  $secureConfirmation = $null
  $plainPassphrase = $null
  $plainConfirmation = $null
  $started = $false
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  try {
    if ($Operation -eq "encrypt") {
      $securePassphrase = Read-Host "Create a backup encryption passphrase (at least 12 characters; store it separately)" -AsSecureString
      $secureConfirmation = Read-Host "Confirm the backup encryption passphrase" -AsSecureString
      $plainPassphrase = ConvertTo-PlainText $securePassphrase
      $plainConfirmation = ConvertTo-PlainText $secureConfirmation
      if ($plainPassphrase -cne $plainConfirmation) { throw "Passphrases did not match; backup was not encrypted." }
    } elseif ($Operation -eq "decrypt") {
      $securePassphrase = Read-Host "Enter the backup encryption passphrase" -AsSecureString
      $plainPassphrase = ConvertTo-PlainText $securePassphrase
    }
    if (-not $process.Start()) { throw "Could not start the backup encryption helper." }
    $started = $true
    if ($Operation -eq "encrypt") {
      $process.StandardInput.WriteLine($plainPassphrase)
      $process.StandardInput.WriteLine($plainConfirmation)
    } elseif ($Operation -eq "decrypt") {
      $process.StandardInput.WriteLine($plainPassphrase)
    }
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Backup encryption helper failed: $($stderr.Trim())" }
    return $stdout.Trim()
  }
  finally {
    if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
    if ($securePassphrase) { $securePassphrase.Dispose() }
    if ($secureConfirmation) { $secureConfirmation.Dispose() }
    $plainPassphrase = $null
    $plainConfirmation = $null
  }
}

function Assert-AgentStopped {
  $rootNeedle = $ProjectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($rootNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
  if ($running) {
    throw "Stop SURVIVE OR DIE before restoring. Close its agent window or stop the scheduled task, then retry."
  }
}

function Recover-IncompleteRestore {
  $journalPath = Join-Path $DataDir "restore-in-progress.json"
  if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) { return }
  Assert-AgentStopped
  $journal = Get-Content -Raw -LiteralPath $journalPath | ConvertFrom-Json
  if ($journal.format -ne 1 -or $journal.configurationPath -ne $ConfigPath) {
    throw "Restore recovery journal is invalid. Keep all recovery files and request manual recovery; no files were changed."
  }
  $expectedDatabase = [System.IO.Path]::GetFullPath((Resolve-DatabasePath))
  $journalDatabase = [System.IO.Path]::GetFullPath([string]$journal.databasePath)
  if (-not [string]::Equals($expectedDatabase, $journalDatabase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Restore recovery journal targets a different database path. No files were changed."
  }
  $databaseRollback = $null
  if ($journal.databaseExisted) {
    $databaseRollback = [string]$journal.databaseRollbackPath
    if (-not (Test-Path -LiteralPath $databaseRollback -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $databaseRollback).Hash.ToLowerInvariant() -ne $journal.databaseRollbackSha256) {
      throw "Pre-restore database snapshot is missing or failed its hash check. No files were changed."
    }
  }
  $configurationRollback = $null
  if ($journal.configurationExisted) {
    $configurationRollback = [string]$journal.configurationRollbackPath
    if (-not (Test-Path -LiteralPath $configurationRollback -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $configurationRollback).Hash.ToLowerInvariant() -ne $journal.configurationRollbackSha256) {
      throw "Pre-restore configuration is missing or failed its hash check. No files were changed."
    }
  }
  if ($journal.databaseExisted) {
    $rollbackDbTemp = "$journalDatabase.recovery-$([guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath $databaseRollback -Destination $rollbackDbTemp
    if (Test-Path -LiteralPath $journalDatabase) {
      $atomicDb = "$journalDatabase.recovery-atomic-$([guid]::NewGuid().ToString('N'))"
      [System.IO.File]::Replace($rollbackDbTemp, $journalDatabase, $atomicDb, $true)
      Remove-Item -LiteralPath $atomicDb -Force -ErrorAction SilentlyContinue
    } else {
      Move-Item -LiteralPath $rollbackDbTemp -Destination $journalDatabase
    }
  } elseif (Test-Path -LiteralPath $journalDatabase) {
    Remove-Item -LiteralPath $journalDatabase -Force
  }
  Remove-Item -LiteralPath "$journalDatabase-wal", "$journalDatabase-shm" -Force -ErrorAction SilentlyContinue
  if ($journal.configurationExisted) {
    $rollbackConfigTemp = "$ConfigPath.recovery-$([guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath $configurationRollback -Destination $rollbackConfigTemp
    if (Test-Path -LiteralPath $ConfigPath) {
      $atomicConfig = "$ConfigPath.recovery-atomic-$([guid]::NewGuid().ToString('N'))"
      [System.IO.File]::Replace($rollbackConfigTemp, $ConfigPath, $atomicConfig, $true)
      Remove-Item -LiteralPath $atomicConfig -Force -ErrorAction SilentlyContinue
    } else {
      Move-Item -LiteralPath $rollbackConfigTemp -Destination $ConfigPath
    }
  } elseif (Test-Path -LiteralPath $ConfigPath) {
    Remove-Item -LiteralPath $ConfigPath -Force
  }
  Remove-Item -LiteralPath $journalPath -Force
  Write-Status "Recovered an interrupted restore by returning to the pre-restore database and configuration."
}

function Backup-Data([string]$ArchivePath) {
  $databasePath = Resolve-DatabasePath
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Configuration not found: $ConfigPath" }
  if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) { throw "Database not found: $databasePath" }
  if (Test-Path -LiteralPath $ArchivePath) { throw "Backup already exists; choose a new path: $ArchivePath" }
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ArchivePath)
  $stage = Join-Path $DataDir (".backup-" + [guid]::NewGuid().ToString("N"))
  $null = New-Item -ItemType Directory -Path $stage
  $stagedEncryptedBackup = Join-Path (Split-Path -Parent $ArchivePath) ("." + [System.IO.Path]::GetFileName($ArchivePath) + ".tmp-" + [guid]::NewGuid().ToString("N"))
  $completed = $false
  try {
    $stagedDatabase = Join-Path $stage "state.db"
    $stagedArchive = Join-Path $stage "payload.zip"
    Invoke-DatabaseCheck $databasePath $stagedDatabase
    Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $stage "automaton.json")
    $manifest = [ordered]@{
      format = 1
      createdAt = (Get-Date).ToUniversalTime().ToString("o")
      databaseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedDatabase).Hash.ToLowerInvariant()
      configurationSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage "automaton.json")).Hash.ToLowerInvariant()
      note = "Contains private configuration. The distributed backup envelope is encrypted with AES-256-GCM."
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage "manifest.json") -Encoding UTF8
    Invoke-DatabaseCheck $stagedDatabase
    Compress-Archive -Path (Join-Path $stage "state.db"), (Join-Path $stage "automaton.json"), (Join-Path $stage "manifest.json") -DestinationPath $stagedArchive
    $null = Invoke-BackupCrypto "encrypt" $stagedArchive $stagedEncryptedBackup
    if ((Invoke-BackupCrypto "detect" $stagedEncryptedBackup) -ne "encrypted") { throw "Encrypted backup verification failed." }
    [System.IO.File]::Move($stagedEncryptedBackup, $ArchivePath)
    $completed = $true
    Write-Status "Encrypted and verified backup created: $ArchivePath"
  }
  finally {
    if (-not $completed -and (Test-Path -LiteralPath $stagedEncryptedBackup)) { Remove-Item -LiteralPath $stagedEncryptedBackup -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Read-VerifiedArchive([string]$ArchivePath, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw "Backup archive not found: $ArchivePath" }
  $encrypted = (Invoke-BackupCrypto "detect" $ArchivePath) -eq "encrypted"
  $zipPath = $ArchivePath
  if ($encrypted) {
    $zipPath = Join-Path $Destination "authenticated-payload.zip"
    $null = Invoke-BackupCrypto "decrypt" $ArchivePath $zipPath
  } else {
    Write-Warning "This is a legacy plaintext ZIP backup. Its contents are not encrypted."
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    $expected = @("automaton.json", "manifest.json", "state.db")
    if ($names.Count -ne 3 -or @($names | Where-Object { $_ -notin $expected }).Count -gt 0 -or @($expected | Where-Object { $_ -notin $names }).Count -gt 0) {
      throw "Backup archive contains unexpected or missing entries."
    }
  }
  finally { $zip.Dispose() }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $Destination -Force
  $databasePath = Join-Path $Destination "state.db"
  $configurationPath = Join-Path $Destination "automaton.json"
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $Destination "manifest.json") | ConvertFrom-Json
  if ($manifest.format -ne 1) { throw "Unsupported backup manifest format." }
  $databaseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $databasePath).Hash.ToLowerInvariant()
  $configurationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $configurationPath).Hash.ToLowerInvariant()
  if ($databaseHash -ne $manifest.databaseSha256 -or $configurationHash -ne $manifest.configurationSha256) {
    throw "Backup SHA-256 verification failed. Nothing was restored."
  }
  $null = Get-Content -Raw -LiteralPath $configurationPath | ConvertFrom-Json
  Invoke-DatabaseCheck $databasePath
  return @{ Database = $databasePath; Configuration = $configurationPath; Encrypted = $encrypted }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required; install the project prerequisites first." }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules/better-sqlite3"))) {
  throw "Application dependencies are missing. Run scripts/windows/install.ps1 first."
}

if (Test-Path -LiteralPath (Join-Path $DataDir "restore-in-progress.json") -PathType Leaf) {
  Write-Warning "An interrupted restore was detected. The script will recover the pre-restore database and configuration before continuing."
  Recover-IncompleteRestore
}

switch ($Action) {
  "backup" {
    if ([string]::IsNullOrWhiteSpace($BackupPath)) {
      $BackupPath = Join-Path $env:USERPROFILE ("SurviveOrDieBackups\survive-or-die-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".sodbackup")
    }
    Backup-Data ([System.IO.Path]::GetFullPath($BackupPath))
  }
  "verify" {
    if ([string]::IsNullOrWhiteSpace($BackupPath)) { throw "Supply -BackupPath to a backup archive." }
    $stage = Join-Path $env:TEMP ("sod-verify-" + [guid]::NewGuid().ToString("N"))
    $null = New-Item -ItemType Directory -Path $stage
    try { $verified = Read-VerifiedArchive ([System.IO.Path]::GetFullPath($BackupPath)) $stage; Write-Status "Archive authentication, hashes and SQLite integrity are valid (encrypted=$($verified.Encrypted))." }
    finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
  "restore" {
    if ([string]::IsNullOrWhiteSpace($BackupPath)) { throw "Supply -BackupPath to a verified backup archive." }
    Assert-AgentStopped
    $null = New-Item -ItemType Directory -Force -Path $DataDir
    $stage = Join-Path $DataDir (".restore-" + [guid]::NewGuid().ToString("N"))
    $null = New-Item -ItemType Directory -Path $stage
    try {
      $verified = Read-VerifiedArchive ([System.IO.Path]::GetFullPath($BackupPath)) $stage
      if (-not $verified.Encrypted) {
        $confirmation = Read-Host "Legacy backup is UNENCRYPTED. Type RESTORE-UNENCRYPTED to continue"
        if ($confirmation -cne "RESTORE-UNENCRYPTED") { throw "Unencrypted legacy restore was not confirmed." }
      }
      $databasePath = Resolve-DatabasePath $verified.Configuration
      $currentDatabasePath = [System.IO.Path]::GetFullPath((Resolve-DatabasePath))
      if (-not [string]::Equals($databasePath, $currentDatabasePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Restore configuration points to a different database path. Restore is restricted to the current configured database; relocate custom databases manually after review."
      }
      $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $databasePath)
      $rollbackStamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $replacementDatabase = "$databasePath.restore-$rollbackStamp"
      $configRollback = "$ConfigPath.pre-restore-$rollbackStamp"
      $restoreConfig = "$ConfigPath.restore-$rollbackStamp"
      $journalPath = Join-Path $DataDir "restore-in-progress.json"
      $journalTemp = "$journalPath.tmp-$([guid]::NewGuid().ToString('N'))"
      $databaseExisted = Test-Path -LiteralPath $databasePath -PathType Leaf
      $configurationExisted = Test-Path -LiteralPath $ConfigPath -PathType Leaf
      $preRestore = $null
      try {
        if ($databaseExisted) {
          $preRestore = "$databasePath.pre-restore-$rollbackStamp"
          Invoke-DatabaseCheck $databasePath $preRestore
        }
        if ($configurationExisted) { Copy-Item -LiteralPath $ConfigPath -Destination $configRollback }
        Copy-Item -LiteralPath $verified.Database -Destination $replacementDatabase
        Invoke-DatabaseCheck $replacementDatabase
        Copy-Item -LiteralPath $verified.Configuration -Destination $restoreConfig
        $journal = [ordered]@{
          format = 1
          databasePath = [System.IO.Path]::GetFullPath($databasePath)
          databaseExisted = $databaseExisted
          databaseRollbackPath = $preRestore
          databaseRollbackSha256 = if ($databaseExisted) { (Get-FileHash -Algorithm SHA256 -LiteralPath $preRestore).Hash.ToLowerInvariant() } else { "" }
          configurationPath = $ConfigPath
          configurationExisted = $configurationExisted
          configurationRollbackPath = if ($configurationExisted) { $configRollback } else { "" }
          configurationRollbackSha256 = if ($configurationExisted) { (Get-FileHash -Algorithm SHA256 -LiteralPath $configRollback).Hash.ToLowerInvariant() } else { "" }
        }
        [System.IO.File]::WriteAllText($journalTemp, ($journal | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::Move($journalTemp, $journalPath)
        Remove-Item -LiteralPath "$databasePath-wal", "$databasePath-shm" -Force -ErrorAction SilentlyContinue
        if ($databaseExisted) {
          $atomicDatabase = "$databasePath.replace-atomic-$([guid]::NewGuid().ToString('N'))"
          [System.IO.File]::Replace($replacementDatabase, $databasePath, $atomicDatabase, $true)
          Remove-Item -LiteralPath $atomicDatabase -Force -ErrorAction SilentlyContinue
        } else {
          Move-Item -LiteralPath $replacementDatabase -Destination $databasePath
        }
        if ($configurationExisted) {
          $atomicConfig = "$ConfigPath.replace-atomic-$([guid]::NewGuid().ToString('N'))"
          [System.IO.File]::Replace($restoreConfig, $ConfigPath, $atomicConfig, $true)
          Remove-Item -LiteralPath $atomicConfig -Force -ErrorAction SilentlyContinue
        } else {
          Move-Item -LiteralPath $restoreConfig -Destination $ConfigPath
        }
        Remove-Item -LiteralPath $journalPath -Force
      } catch {
        if (Test-Path -LiteralPath $journalPath -PathType Leaf) { Recover-IncompleteRestore }
        throw
      } finally {
        Remove-Item -LiteralPath $journalTemp, $replacementDatabase, $restoreConfig -Force -ErrorAction SilentlyContinue
      }
      if ($preRestore) { Write-Status "Previous database preserved at $preRestore" }
      Write-Status "Restore completed; start the agent and inspect its diagnostic log."
    }
    finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
