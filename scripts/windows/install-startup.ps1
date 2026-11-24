$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$RunScript = Join-Path $PSScriptRoot "run-agent.ps1"
if (-not (Test-Path (Join-Path $ProjectRoot "dist/index.js"))) {
  throw "Build the application first with scripts/windows/install.ps1."
}

$TaskName = "SurviveOrDieAgent"
$UserId = (whoami).Trim()
$Action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $RunScript + '"')
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "Starts the local-only Survive or Die agent at sign-in and retries after a crash." -Force | Out-Null
Write-Host "Startup task '$TaskName' is installed for $UserId."
Write-Host "It starts after sign-in and retries a failed run up to five times at one-minute intervals."
Write-Host "Agent data and logs remain under $env:USERPROFILE\.automaton."
