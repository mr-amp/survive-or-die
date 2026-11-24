$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$DataDir = Join-Path $env:USERPROFILE ".automaton"
$LogDir = Join-Path $DataDir "logs"
$LogFile = Join-Path $LogDir "agent.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Push-Location $ProjectRoot
try {
  if (-not (Test-Path (Join-Path $ProjectRoot "dist/index.js"))) {
    throw "Built application is missing. Run scripts/windows/install.ps1 first."
  }
  & node (Join-Path $ProjectRoot "dist/index.js") 2>&1 | Tee-Object -FilePath $LogFile -Append
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
