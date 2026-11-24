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

function Assert-AgentStopped {
  $rootNeedle = $ProjectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($rootNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
  if ($running) {
    throw "Stop SURVIVE OR DIE before restoring. Close its agent window or stop the scheduled task, then retry."
  }
}

function Backup-Data([string]$ArchivePath) {
  $databasePath = Resolve-DatabasePath
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Configuration not found: $ConfigPath" }
  if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) { throw "Database not found: $databasePath" }
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ArchivePath)
  $stage = Join-Path $DataDir (".backup-" + [guid]::NewGuid().ToString("N"))
  $null = New-Item -ItemType Directory -Path $stage
  try {
    $stagedDatabase = Join-Path $stage "state.db"
    Invoke-DatabaseCheck $databasePath $stagedDatabase
    Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $stage "automaton.json")
    $manifest = [ordered]@{
      format = 1
      createdAt = (Get-Date).ToUniversalTime().ToString("o")
      databaseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedDatabase).Hash.ToLowerInvariant()
      configurationSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stage "automaton.json")).Hash.ToLowerInvariant()
      note = "Contains private configuration. Keep this archive in a user-private location; it is not encrypted."
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage "manifest.json") -Encoding UTF8
    Invoke-DatabaseCheck $stagedDatabase
    if (Test-Path -LiteralPath $ArchivePath) { throw "Backup already exists; choose a new path: $ArchivePath" }
    Compress-Archive -Path (Join-Path $stage "state.db"), (Join-Path $stage "automaton.json"), (Join-Path $stage "manifest.json") -DestinationPath $ArchivePath
    Write-Status "Verified backup created: $ArchivePath"
  }
  finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

function Read-VerifiedArchive([string]$ArchivePath, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw "Backup archive not found: $ArchivePath" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    $expected = @("automaton.json", "manifest.json", "state.db")
    if ($names.Count -ne 3 -or @($names | Where-Object { $_ -notin $expected }).Count -gt 0 -or @($expected | Where-Object { $_ -notin $names }).Count -gt 0) {
      throw "Backup archive contains unexpected or missing entries."
    }
  }
  finally { $zip.Dispose() }
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Destination -Force
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
  return @{ Database = $databasePath; Configuration = $configurationPath }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required; install the project prerequisites first." }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules/better-sqlite3"))) {
  throw "Application dependencies are missing. Run scripts/windows/install.ps1 first."
}

switch ($Action) {
  "backup" {
    if ([string]::IsNullOrWhiteSpace($BackupPath)) {
      $BackupPath = Join-Path $env:USERPROFILE ("SurviveOrDieBackups\survive-or-die-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")
    }
    Backup-Data ([System.IO.Path]::GetFullPath($BackupPath))
  }
  "verify" {
    if ([string]::IsNullOrWhiteSpace($BackupPath)) { throw "Supply -BackupPath to a backup archive." }
    $stage = Join-Path $env:TEMP ("sod-verify-" + [guid]::NewGuid().ToString("N"))
    $null = New-Item -ItemType Directory -Path $stage
    try { $null = Read-VerifiedArchive ([System.IO.Path]::GetFullPath($BackupPath)) $stage; Write-Status "Archive hashes and SQLite integrity are valid." }
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
      $databasePath = Resolve-DatabasePath $verified.Configuration
      $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $databasePath)
      $rollbackStamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $replacementDatabase = "$databasePath.restore-$rollbackStamp"
      Copy-Item -LiteralPath $verified.Database -Destination $replacementDatabase
      Invoke-DatabaseCheck $replacementDatabase
      if (Test-Path -LiteralPath $databasePath) {
        $preRestore = "$databasePath.pre-restore-$rollbackStamp"
        Invoke-DatabaseCheck $databasePath $preRestore
        $atomicReplaceBackup = "$databasePath.atomic-replace-$rollbackStamp"
        [System.IO.File]::Replace($replacementDatabase, $databasePath, $atomicReplaceBackup, $true)
        Remove-Item -LiteralPath $atomicReplaceBackup -Force -ErrorAction SilentlyContinue
        Write-Status "Previous database preserved at $preRestore"
      } else {
        Move-Item -LiteralPath $replacementDatabase -Destination $databasePath
      }
      Remove-Item -LiteralPath "$databasePath-wal", "$databasePath-shm" -Force -ErrorAction SilentlyContinue
      $configRollback = "$ConfigPath.pre-restore-$rollbackStamp"
      $restoreConfig = "$ConfigPath.restore-$rollbackStamp"
      Copy-Item -LiteralPath $verified.Configuration -Destination $restoreConfig
      if (Test-Path -LiteralPath $ConfigPath) {
        [System.IO.File]::Replace($restoreConfig, $ConfigPath, $configRollback, $true)
      } else {
        Move-Item -LiteralPath $restoreConfig -Destination $ConfigPath
      }
      Write-Status "Restore completed; start the agent and inspect its diagnostic log."
    }
    finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
