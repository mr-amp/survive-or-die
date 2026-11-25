[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$DataDir = Join-Path $env:USERPROFILE ".automaton"
$LogDir = Join-Path $DataDir "logs"
$ReportPath = Join-Path $LogDir "self-mod-isolation-readiness.json"

$registry = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
$computer = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
$processors = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
$edition = [string]$registry.EditionID
$product = [string]$registry.ProductName
$architecture = [string]$os.OSArchitecture
$memoryBytes = [int64]$computer.TotalPhysicalMemory
$processorCount = ($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
$virtualizationEnabled = $processors.Count -gt 0 -and @($processors | Where-Object { $_.VirtualizationFirmwareEnabled -ne $true }).Count -eq 0
$sandboxFeatureState = "unknown"
$availableDiskBytes = 0

try {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -ErrorAction Stop
  $sandboxFeatureState = [string]$feature.State
} catch {
  # A non-elevated session may be unable to inspect the optional Windows feature.
  $sandboxFeatureState = "unknown"
}

try {
  $systemDrive = [System.IO.Path]::GetPathRoot($env:SystemRoot)
  $systemDriveId = $systemDrive.Substring(0, 2)
  $drive = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$systemDriveId'" -ErrorAction Stop
  if ($drive) { $availableDiskBytes = [int64]$drive.FreeSpace }
} catch {
  $availableDiskBytes = 0
}

$supportedEditions = @("Professional", "ProfessionalEducation", "ProfessionalWorkstation", "Education", "Enterprise")
$requirements = @(
  @{ name = "supported_edition"; passed = ($supportedEditions -contains $edition); observed = $edition },
  @{ name = "supported_architecture"; passed = ($architecture -match "64-bit|ARM64|x64|AMD64"); observed = $architecture },
  @{ name = "firmware_virtualization"; passed = $virtualizationEnabled; observed = [bool]$virtualizationEnabled },
  @{ name = "sandbox_optional_feature"; passed = ($sandboxFeatureState -eq "Enabled"); observed = $sandboxFeatureState },
  @{ name = "host_memory_minimum_4gb"; passed = ($memoryBytes -ge 4GB); observed = [math]::Round($memoryBytes / 1GB, 1) },
  @{ name = "host_memory_recommended_8gb"; passed = ($memoryBytes -ge 8GB); observed = [math]::Round($memoryBytes / 1GB, 1) },
  @{ name = "processor_minimum_2"; passed = ([int]$processorCount -ge 2); observed = [int]$processorCount },
  @{ name = "free_disk_minimum_1gb"; passed = ($availableDiskBytes -ge 1GB); observed = [math]::Round($availableDiskBytes / 1GB, 1) }
)
$blockers = @($requirements | Where-Object { $_.name -in @("supported_edition", "supported_architecture", "firmware_virtualization", "sandbox_optional_feature", "host_memory_minimum_4gb", "processor_minimum_2", "free_disk_minimum_1gb") -and -not $_.passed } | ForEach-Object { $_.name })
$report = [ordered]@{
  format = 1
  detectedAt = (Get-Date).ToUniversalTime().ToString("o")
  operatingSystem = $product
  edition = $edition
  build = [string]$registry.CurrentBuild
  architecture = $architecture
  hostMemoryBytes = $memoryBytes
  logicalProcessorCount = [int]$processorCount
  firmwareVirtualizationEnabled = [bool]$virtualizationEnabled
  hypervisorPresent = [bool]$computer.HypervisorPresent
  sandboxFeatureState = $sandboxFeatureState
  freeSystemDriveBytes = $availableDiskBytes
  requirements = $requirements
  blockers = $blockers
  readyForOwnerReview = ($blockers.Count -eq 0)
  candidateExecutionEnabled = $false
  limits = [ordered]@{
    sandboxMemoryMb = 4096
    network = "disabled in proposed sandbox configuration"
    hostCandidateMount = "read-only"
    clipboard = "disabled in proposed sandbox configuration"
    cpuQuota = "not exposed by the documented Windows Sandbox configuration"
    executionTimeout = "not enforced; owner must monitor and close the disposable sandbox"
  }
  note = "Readiness detection only. This script did not enable Windows features, launch a sandbox or execute candidate code. Physical isolation and resource behavior still require owner verification."
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
[System.IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
Write-Host "Readiness report saved under .automaton\logs\self-mod-isolation-readiness.json"
Write-Host "Windows Sandbox owner review readiness: $($report.readyForOwnerReview); candidate execution remains disabled."
