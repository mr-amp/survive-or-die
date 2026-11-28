[CmdletBinding()]
param(
  [ValidateSet("16gb", "32gb")]
  [string]$Profile = "16gb",
  [string]$Model = "llama3.1:8b"
)

$ErrorActionPreference = "Stop"
if ($Model -match "(?i):cloud$") {
  throw "Local-only installation cannot use Ollama cloud models. Choose a locally downloaded model."
}
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20 or newer is required. Install it from https://nodejs.org/ and reopen PowerShell."
}
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  throw "Node.js 20 or newer is required; found $(& node --version)."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue) -and (Get-Command corepack -ErrorAction SilentlyContinue)) {
  & corepack enable
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is required. Run 'corepack enable' in an elevated PowerShell, reopen PowerShell, then retry."
}
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  throw "Ollama is required for local-only mode. Install it from https://ollama.com/download/windows, start it, then retry."
}

$parallel = if ($Profile -eq "32gb") { "2" } else { "1" }
[Environment]::SetEnvironmentVariable("OLLAMA_MAX_LOADED_MODELS", "1", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_NUM_PARALLEL", $parallel, "User")
$env:OLLAMA_MAX_LOADED_MODELS = "1"
$env:OLLAMA_NUM_PARALLEL = $parallel
$env:OLLAMA_KEEP_ALIVE = "5m"

Write-Host "Ollama profile: $Profile; maximum loaded models: 1; parallel requests: $parallel"
Write-Host "Checking local model $Model..."
$modelList = (& ollama list 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "Ollama is installed but its local service is unavailable. Start Ollama from the Start menu and rerun this script."
}
$modelPattern = "(?m)^" + [regex]::Escape($Model) + "(?:\s|$)"
if ($modelList -notmatch $modelPattern) {
  & ollama pull $Model
  if ($LASTEXITCODE -ne 0) {
    throw "Model download failed. Check the Ollama service and disk space, then run 'ollama pull $Model'."
  }
}

Push-Location $ProjectRoot
try {
  $packageManager = [string](Get-Content -Raw -Path (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json).packageManager
  if ($packageManager -notmatch '^pnpm@(?<version>\d+\.\d+\.\d+)$') {
    throw "package.json must declare an exact pinned pnpm version; found '$packageManager'."
  }
  $expectedPnpmVersion = $Matches.version
  $actualPnpmVersion = (& pnpm --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualPnpmVersion -ne $expectedPnpmVersion) {
    throw "This repository requires pnpm $expectedPnpmVersion (found '$actualPnpmVersion'). From the repository folder run 'corepack enable', then verify 'pnpm --version' before retrying."
  }

  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Build failed; see the TypeScript output above." }
  $ConfigPath = Join-Path $env:USERPROFILE ".automaton/automaton.json"
  if (-not (Test-Path $ConfigPath)) {
    Write-Host "Starting first-run setup. Keep local-only selected and use model $Model."
    & pnpm exec tsx src/index.ts --setup
    if ($LASTEXITCODE -ne 0) { throw "Initial setup did not complete." }
  } else {
    $config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
    if ($config.localOnly -eq $true) {
      $backupPath = "$ConfigPath.bak.$(Get-Date -Format yyyyMMddHHmmss)"
      Copy-Item -Path $ConfigPath -Destination $backupPath
      $config | Add-Member -NotePropertyName localProfile -NotePropertyValue $Profile -Force
      $config | Add-Member -NotePropertyName maxChildren -NotePropertyValue $(if ($Profile -eq "32gb") { 2 } else { 1 }) -Force
      $config | Add-Member -NotePropertyName maxTokensPerTurn -NotePropertyValue $(if ($Profile -eq "32gb") { 4096 } else { 2048 }) -Force
      $json = $config | ConvertTo-Json -Depth 100
      [System.IO.File]::WriteAllText($ConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
      Write-Host "Updated local resource profile; previous config backed up to $backupPath."
    } else {
      Write-Warning "Existing config uses Conway mode and was not changed. Run 'pnpm exec tsx src/index.ts --setup', choose local-only, then rerun this script."
    }
  }
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "Setup finished. Start manually with:"
Write-Host ('  powershell -ExecutionPolicy Bypass -File "' + $PSScriptRoot + '\run-agent.ps1"')
Write-Host "Restart Ollama once so it reads the new resource settings."

