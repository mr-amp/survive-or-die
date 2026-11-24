[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$DeleteData)

$ErrorActionPreference = "Stop"
$TaskName = "SurviveOrDieAgent"
$DataDir = Join-Path $env:USERPROFILE ".automaton"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed startup task '$TaskName'."
}
if ($DeleteData) {
  if ($PSCmdlet.ShouldProcess($DataDir, "Permanently delete agent configuration, wallet, memory, and SQLite database")) {
    $confirmation = Read-Host "Type DELETE to permanently remove $DataDir"
    if ($confirmation -ne "DELETE") { throw "Data deletion cancelled." }
    Remove-Item -Recurse -Force $DataDir
    Write-Host "Deleted $DataDir."
  }
} else {
  Write-Host "Agent data, wallet, memory, and SQLite database were kept at $DataDir."
  Write-Host "To delete them explicitly, rerun with -DeleteData."
}
