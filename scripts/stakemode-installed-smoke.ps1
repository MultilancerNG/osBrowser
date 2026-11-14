#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InstallerPath,
  [string]$ReportPath = 'artifacts/STAKEMODE-INSTALLED-ACCEPTANCE.json'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true') { throw 'Installed GUI smoke requires a fresh GitHub Windows runner.' }
if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [Runtime.InteropServices.Architecture]::X64) { throw 'Installed GUI smoke requires a Windows x64 process.' }
$repo = Split-Path $PSScriptRoot -Parent
$reportFile = [IO.Path]::GetFullPath($ReportPath)
$version = ([IO.File]::ReadAllText((Join-Path $repo 'package.json')) | ConvertFrom-Json).version
if ($version -isnot [string] -or [string]::IsNullOrWhiteSpace($version)) { throw 'Installed GUI smoke requires the application version.' }
$sourceSha = $env:STAKEMODE_SOURCE_SHA
if ($sourceSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Installed GUI smoke requires the exact validated STAKEMODE_SOURCE_SHA.' }
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if ((Split-Path $installer -Leaf) -cne "StakeMode_${version}_x64-setup.exe") { throw 'Unexpected installed-smoke installer identity.' }
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { throw 'A runner-owned temporary directory is required.' }
$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $env:RUNNER_TEMP "StakeModeSmoke-$runId"
$installRoot = Join-Path $runRoot 'installed'
$webViewRoot = Join-Path $runRoot 'webview'
# Windows KnownFolder APIs can ignore APPDATA environment overrides. Claim only
# fresh product-specific KnownFolder roots; never remove a pre-existing profile.
$appDataRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.solomongs.stakemode'
$localDataRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'com.solomongs.stakemode'
$ownedRoots = [Collections.Generic.List[string]]::new()
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$ownedIdentities = [Collections.Generic.HashSet[string]]::new()
$capturedOwnedTree = @{}
$unresolvedObservedProcesses = @{}
$debugPort = 19299
$desktop = $null
$sidecar = $null
$installationAttempted = $false
$started = [DateTime]::UtcNow
$passed = $false
$report = [ordered]@{ product = 'StakeMode'; version = $version; source = $sourceSha; platform = 'win32'; architecture = 'x64'; startedAt = $started.ToString('o'); finishedAt = $null; passed = $false; cleanupConfirmed = $false; checks = @() }
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($reportFile))
[IO.File]::WriteAllText($reportFile, ($report | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))
$details = [ordered]@{ installed = $false; nativeWindowCreated = $false; installedSidecarVerified = $false; installedWebViewRendered = $false; gracefulNativeClose = $false; ownedProcessesExited = $false; uninstalled = $false; pageScope = 'Loopback workspace only; zero browser profiles or website accounts.' }
$details.processBinding = [ordered]@{ attempts = 0; observedRows = 0; boundRows = 0; unknownRows = 0; unresolvedObservedRows = 0; outcome = 'not-started'; lastFailureStage = 'none'; lastFailureRole = 'none'; nativeErrorCode = $null }
$failure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$httpHandler = [Net.Http.HttpClientHandler]::new(); $httpHandler.UseProxy = $false; $httpHandler.AllowAutoRedirect = $false
$http = [Net.Http.HttpClient]::new($httpHandler); $http.Timeout = [TimeSpan]::FromSeconds(2)
function Read-LocalJson([string]$Path, [hashtable]$Headers = @{}) {
  if ($Path -notmatch '^/(?:ui/api/health|workspace/api/(?:bootstrap|snapshot))$') { throw 'Unexpected installed smoke API path.' }
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "http://127.0.0.1:8080$Path")
  foreach ($key in $Headers.Keys) { [void]$request.Headers.TryAddWithoutValidation($key, [string]$Headers[$key]) }
  try {
    $response = $http.SendAsync($request).GetAwaiter().GetResult()
    try {
      if ([int]$response.StatusCode -ne 200) { throw 'Installed loopback endpoint returned an unexpected status.' }
      $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      if ($bytes.Length -gt 2097152) { throw 'Installed loopback response exceeded its bound.' }
      return [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    } finally { $response.Dispose() }
  } finally { $request.Dispose() }
}
# Query the kernel image name on an already-held handle. MainModule enumerates
# the target's changing loader lists and is unsuitable as startup identity proof.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class StakeModeNativeImage {
  [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  public static string Read(IntPtr process) {
    var name = new StringBuilder(32768);
    uint size = (uint)name.Capacity;
    if (!QueryFullProcessImageNameW(process, 0, name, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return name.ToString();
  }
}
'@
function Has-Exited([Diagnostics.Process]$Process) {
  if (-not $Process) { return $true }
  try { $Process.Refresh(); return $Process.HasExited } catch { throw 'Owned process exit status is unavailable.' }
}
function Remember-Process([Diagnostics.Process]$Process) {
  # Acquiring the kernel handle binds cleanup to this actual process generation.
  $null = $Process.Handle
  $identity = "$($Process.Id):$($Process.StartTime.ToUniversalTime().Ticks)"
  if ($ownedIdentities.Add($identity)) { $ownedProcesses.Add($Process) }
  elseif (-not ($ownedProcesses | Where-Object { [Object]::ReferenceEquals($_, $Process) })) { $Process.Dispose() }
}
function Record-BindingFailure([string]$Stage, [string]$Role, $Failure, [string]$Outcome = 'unknown') {
  $nativeCode = $null; $exception = $Failure.Exception
  for ($depth = 0; $exception -and $depth -lt 8; $depth++) {
    if ($exception -is [ComponentModel.Win32Exception]) { $nativeCode = $exception.NativeErrorCode; break }
    $exception = $exception.InnerException
  }
  $details.processBinding.lastFailureStage = $Stage
  $details.processBinding.lastFailureRole = $Role
  $details.processBinding.nativeErrorCode = $nativeCode
  $details.processBinding.outcome = $Outcome
}
function Read-CompleteProcessTable {
  $records = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3)
  $seen = [Collections.Generic.HashSet[int]]::new(); $positive = 0
  foreach ($row in $records) {
    if (-not $seen.Add([int]$row.ProcessId)) { throw 'Native process table contains duplicate identities.' }
    if ($row.ProcessId -gt 0) { $positive++ }
  }
  if (-not $positive) { throw 'Native process table is unavailable.' }
  return $records
}
function Track-UnresolvedObservation($Row) {
  if (-not $script:unresolvedObservedProcesses.ContainsKey([int]$Row.ProcessId)) {
    $birth = if ($Row.CreationDate) { $Row.CreationDate.ToUniversalTime().Ticks } else { $null }
    $script:unresolvedObservedProcesses[[int]$Row.ProcessId] = $birth
  }
}
function Resolve-ObservedAbsence($Records) {
  $byId = @{}; foreach ($row in $Records) { $byId[[int]$row.ProcessId] = $row }
  foreach ($observedId in @($script:unresolvedObservedProcesses.Keys)) {
    $current = $byId[[int]$observedId]; $birth = $script:unresolvedObservedProcesses[$observedId]
    if (-not $current -or ($null -ne $birth -and $current.CreationDate -and $current.CreationDate.ToUniversalTime().Ticks -ne $birth)) {
      $script:unresolvedObservedProcesses.Remove($observedId)
    }
  }
  $details.processBinding.unresolvedObservedRows = $script:unresolvedObservedProcesses.Count
}
function Wait-ObservedAbsence {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    try { Resolve-ObservedAbsence @(Read-CompleteProcessTable) } catch { Record-BindingFailure 'cleanup-snapshot' 'other' $_ }
    if (-not $script:unresolvedObservedProcesses.Count) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Previously observed unresolved desktop children remain unconfirmed after cleanup.'
}
function Capture-OwnedTree {
  $script:capturedOwnedTree = @{}
  $proof = $details.processBinding; $proof.attempts++; $proof.observedRows = 0; $proof.boundRows = 0; $proof.unknownRows = 0
  $stage = 'root-exit'; $hardFailure = $false
  try {
    if (-not $desktop -or (Has-Exited $desktop)) { $hardFailure = $true; throw 'Desktop exited before its native tree was verified.' }
    $stage = 'cim-snapshot'
    $records = @(Read-CompleteProcessTable)
    Resolve-ObservedAbsence $records
    $root = $records | Where-Object { $_.ProcessId -eq $desktop.Id } | Select-Object -First 1
    $stage = 'root-generation'
    if (-not $root -or -not $root.CreationDate -or [Math]::Abs(($desktop.StartTime.ToUniversalTime() - $root.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) {
      $hardFailure = $true; throw 'Desktop generation changed during installed smoke.'
    }
    $stage = 'root-image'
    $nativeRootImage = [StakeModeNativeImage]::Read($desktop.Handle)
    if ([string]::IsNullOrWhiteSpace($root.ExecutablePath) -or
        -not ([IO.Path]::GetFullPath($nativeRootImage).Equals([IO.Path]::GetFullPath($desktop.StartInfo.FileName), [StringComparison]::OrdinalIgnoreCase)) -or
        -not ([IO.Path]::GetFullPath($nativeRootImage).Equals([IO.Path]::GetFullPath($root.ExecutablePath), [StringComparison]::OrdinalIgnoreCase))) {
      $hardFailure = $true; throw 'Desktop executable changed during installed smoke.'
    }
  } catch {
    Record-BindingFailure $stage 'desktop' $_ $(if ($hardFailure) { 'mismatch' } else { 'unknown' })
    if ($hardFailure) { throw 'Desktop ownership changed during installed smoke.' }
    $proof.unknownRows++; return $false
  }
  $known = @{}; $known[[int]$root.ProcessId] = $root
  do {
    $changed = $false
    foreach ($row in $records) {
      if ($known.ContainsKey([int]$row.ProcessId) -or -not $known.ContainsKey([int]$row.ParentProcessId)) { continue }
      $parent = $known[[int]$row.ParentProcessId]
      if ($row.CreationDate -and $parent.CreationDate -and $row.CreationDate -lt $parent.CreationDate) { continue }
      $known[[int]$row.ProcessId] = $row; $changed = $true
    }
  } while ($changed)
  $proof.observedRows = $known.Count
  # Unknown ancestry time is not permission to adopt that row or its children.
  if (@($known.Values | Where-Object { -not $_.CreationDate }).Count) {
    foreach ($unverified in $known.Values) { if ($unverified.ProcessId -ne $desktop.Id) { Track-UnresolvedObservation $unverified } }
    $proof.unknownRows++; $proof.unresolvedObservedRows = $script:unresolvedObservedProcesses.Count
    Record-BindingFailure 'cim-creation' 'other' $null; return $false
  }
  $bound = @{}; $verifiedHandles = [Collections.Generic.List[Diagnostics.Process]]::new()
  foreach ($row in $known.Values) {
    $candidate = $null; $stage = 'open-process'
    $role = if ($row.ProcessId -eq $desktop.Id) { 'desktop' } elseif ($sidecar -and $row.ProcessId -eq $sidecar.Id) { 'sidecar' } elseif ($row.Name -ieq 'msedgewebview2.exe') { 'webview' } else { 'other' }
    try {
      $candidate = [Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
      $stage = 'hold-handle'; $null = $candidate.Handle
      $stage = 'start-time'; $nativeStart = $candidate.StartTime.ToUniversalTime()
      $stage = 'generation-match'
      if ([Math]::Abs(($nativeStart - $row.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) { throw 'Child generation changed during observation.' }
      $stage = 'native-image'; $nativeImage = [StakeModeNativeImage]::Read($candidate.Handle)
      $stage = 'cim-image'
      if ([string]::IsNullOrWhiteSpace($row.ExecutablePath)) { throw 'Child image metadata is unavailable.' }
      $stage = 'image-match'
      if (-not ([IO.Path]::GetFullPath($nativeImage).Equals([IO.Path]::GetFullPath($row.ExecutablePath), [StringComparison]::OrdinalIgnoreCase))) { throw 'Child image changed during observation.' }
      $stage = 'exit-check'
      if (Has-Exited $candidate) { $script:unresolvedObservedProcesses.Remove([int]$row.ProcessId); $candidate.Dispose(); continue }
      $verifiedHandles.Add($candidate)
      $bound[[int]$row.ProcessId] = $row; $proof.boundRows++
    } catch {
      $failure = $_; $exited = $false
      if ($candidate) {
        # A read/status exception is unknown. Only a successful true observation
        # of this exact held generation can establish that the candidate exited.
        try { $exited = Has-Exited $candidate } catch { $exited = $false }
        $candidate.Dispose()
      }
      if ($exited) { $script:unresolvedObservedProcesses.Remove([int]$row.ProcessId) }
      else { Track-UnresolvedObservation $row; $proof.unknownRows++; Record-BindingFailure $stage $role $failure }
    }
  }
  foreach ($boundId in $bound.Keys) { $script:unresolvedObservedProcesses.Remove([int]$boundId) }
  $proof.unresolvedObservedRows = $script:unresolvedObservedProcesses.Count
  if ($proof.unknownRows -or $proof.unresolvedObservedRows) {
    # Do not promote partial-tree observations to kill authority. Their PIDs
    # remain unresolved until later binding, exact held exit, or fresh absence.
    foreach ($unverified in $known.Values) { if ($unverified.ProcessId -ne $desktop.Id) { Track-UnresolvedObservation $unverified } }
    foreach ($verified in $verifiedHandles) { $verified.Dispose() }
    $proof.unresolvedObservedRows = $script:unresolvedObservedProcesses.Count
    return $false
  }
  try { foreach ($verified in $verifiedHandles) { Remember-Process $verified } }
  catch { Record-BindingFailure 'remember-process' 'other' $_; throw 'Verified desktop process registration failed.' }
  $proof.outcome = 'complete'; $script:capturedOwnedTree = $bound; return $true
}
function Wait-BoundOwnedTree([int]$TimeoutMs = 20000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1, [Math]::Min(20000, $TimeoutMs)))
  do {
    if (Capture-OwnedTree) { return }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 200
  } while ($true)
  throw 'Complete owned desktop process identity remained unavailable within its observation bound.'
}
function Assert-OwnedWebViewEndpoint([string]$Phase, [string]$ExpectedIdentity = '') {
  $proof = [ordered]@{ capturedWebViewCount = 0; listenerCount = 0; loopbackListenerCount = 0; loopbackOnly = $false; heldGenerationAndPathMatched = $false }
  $details.webViewOwnership[$Phase] = $proof
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Wait-BoundOwnedTree ([int][Math]::Max(1, ($deadline - [DateTime]::UtcNow).TotalMilliseconds))
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $debugPort -ErrorAction SilentlyContinue)
    $proof.listenerCount = $listeners.Count
    $proof.loopbackListenerCount = @($listeners | Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') }).Count
    $proof.loopbackOnly = $listeners.Count -gt 0 -and $proof.loopbackListenerCount -eq $listeners.Count
    if ($listeners.Count -gt 0 -and -not $proof.loopbackOnly) { throw 'Installed WebView debug listener is not loopback-only.' }
    $webViews = @($ownedProcesses | Where-Object {
      -not (Has-Exited $_) -and $script:capturedOwnedTree.ContainsKey([int]$_.Id) -and
        [IO.Path]::GetFileName([string]$script:capturedOwnedTree[[int]$_.Id].ExecutablePath) -ieq 'msedgewebview2.exe'
    })
    $proof.capturedWebViewCount = $webViews.Count
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if (@($listeners | Where-Object { $_.LocalAddress -eq '127.0.0.1' }).Count -gt 0 -and $owners.Count -eq 1) {
      foreach ($held in $webViews) {
        if ($held.Id -ne $owners[0] -or (Has-Exited $held)) { continue }
        $record = $script:capturedOwnedTree[[int]$held.Id]
        try {
          if ([Math]::Abs(($held.StartTime.ToUniversalTime() - $record.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1 -or
              -not ([IO.Path]::GetFullPath(([StakeModeNativeImage]::Read($held.Handle))).Equals([IO.Path]::GetFullPath($record.ExecutablePath), [StringComparison]::OrdinalIgnoreCase))) {
            throw 'Installed WebView listener generation or executable changed.'
          }
        } catch { Record-BindingFailure 'listener-identity' 'webview' $_; throw 'Installed WebView listener identity could not be verified.' }
        $identity = "$($held.Id):$($held.StartTime.ToUniversalTime().Ticks)"
        if ($ExpectedIdentity -and $identity -cne $ExpectedIdentity) { throw 'Installed WebView debug listener generation changed during inspection.' }
        if (Has-Exited $held) { continue }
        $proof.heldGenerationAndPathMatched = $true
        if ($ExpectedIdentity) { $proof.sameGenerationAsBefore = $true }
        return $identity
      }
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Installed native WebView debug listener did not match a live held desktop descendant within its readiness bound.'
}
function Run-OwnedInstaller([string]$Executable, [string[]]$Arguments, [int]$TimeoutMs) {
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru
  $null = $process.Handle
  try {
    if (-not $process.WaitForExit($TimeoutMs)) { $process.Kill(); [void]$process.WaitForExit(10000); throw 'Owned installer/uninstaller exceeded its execution bound.' }
    if ($process.ExitCode -ne 0) { throw "Owned installer/uninstaller exited with code $($process.ExitCode)." }
  } finally { $process.Dispose() }
}
function Assert-InstallerRejectsOwnedSentinels {
  $directory = Join-Path $runRoot 'owned-process-sentinels'; New-Item -ItemType Directory -Path $directory | Out-Null
  $ping = Join-Path $env:SystemRoot 'System32/ping.exe'
  $mainPath = Join-Path $directory 'stakemode.exe'; $sidecarSentinelPath = Join-Path $directory 'stakemode-sidecar.exe'
  Copy-Item -LiteralPath $ping -Destination $mainPath; Copy-Item -LiteralPath $ping -Destination $sidecarSentinelPath
  $mainSentinel = Start-Process -FilePath $mainPath -ArgumentList @('-t', '127.0.0.1') -WindowStyle Hidden -PassThru; Remember-Process $mainSentinel
  $sidecarSentinel = Start-Process -FilePath $sidecarSentinelPath -ArgumentList @('-t', '127.0.0.1') -WindowStyle Hidden -PassThru; Remember-Process $sidecarSentinel
  try {
    foreach ($phase in @('main-and-sidecar', 'sidecar-only')) {
      $probe = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$(Join-Path $runRoot ('rejected-' + $phase))") -PassThru
      $null = $probe.Handle
      try {
        if (-not $probe.WaitForExit(60000)) { $probe.Kill(); [void]$probe.WaitForExit(10000); throw 'Silent installer did not reject an existing process within its bound.' }
        if ($probe.ExitCode -eq 0) { throw 'Silent installer accepted a live owned process sentinel.' }
      } finally { $probe.Dispose() }
      if ((Has-Exited $sidecarSentinel) -or ($phase -eq 'main-and-sidecar' -and (Has-Exited $mainSentinel))) { throw 'Installer terminated an unrelated same-name process sentinel.' }
      if ($phase -eq 'main-and-sidecar') { $mainSentinel.Kill(); if (-not $mainSentinel.WaitForExit(10000)) { throw 'Owned main sentinel failed to stop.' } }
    }
    $details.installerRejectsWithoutKilling = @{ mainAndSidecar = $true; sidecarOnly = $true; target = 'Two directly owned copies of Windows ping.exe, loopback only.' }
  } finally {
    foreach ($sentinel in @($mainSentinel, $sidecarSentinel)) { if (-not (Has-Exited $sentinel)) { $sentinel.Kill(); if (-not $sentinel.WaitForExit(10000)) { throw 'Owned sentinel cleanup failed.' } } }
  }
}
try {
  if (@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('stakemode.exe', 'stakemode-sidecar.exe') }).Count) { throw 'An existing StakeMode process prevents isolated installed smoke.' }
  if (@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(8080, $debugPort) }).Count) { throw 'An installed smoke loopback port is already in use.' }
  $registered = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'StakeMode' })
  if ($registered.Count) { throw 'A previous StakeMode installation prevents isolated installed smoke.' }
  foreach ($root in @($appDataRoot, $localDataRoot) | Select-Object -Unique) { if (Test-Path -LiteralPath $root) { throw 'Pre-existing StakeMode data is protected; installed smoke refused.' } }
  if (Test-Path -LiteralPath $runRoot) { throw 'Installed smoke temporary root was not fresh.' }
  New-Item -ItemType Directory -Path $runRoot, $webViewRoot | Out-Null
  foreach ($root in @($appDataRoot, $localDataRoot) | Select-Object -Unique) {
    New-Item -ItemType Directory -Path $root | Out-Null
    [IO.File]::WriteAllText((Join-Path $root '.stakemode-smoke-owner'), $runId); $ownedRoots.Add($root)
  }
  Write-Host 'StakeMode installed smoke: checking non-killing installer process guards.'
  Assert-InstallerRejectsOwnedSentinels
  Write-Host 'StakeMode installed smoke: installing the exact NSIS build.'
  $installationAttempted = $true
  Run-OwnedInstaller $installer @('/S', "/D=$installRoot") 300000
  $details.installed = $true
  $app = Join-Path $installRoot 'stakemode.exe'
  $sidecarPath = Join-Path $installRoot 'stakemode-sidecar.exe'
  foreach ($relative in @('stakemode.exe', 'stakemode-sidecar.exe', 'playwright/node/node.exe', 'playwright/stakemode/workspace/dashboard.html', 'playwright/stakemode/workspace/dashboard.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot $relative) -PathType Leaf)) { throw "Installed resource is missing: $relative" }
  }
  # Pinned Tauri replaces the one UNK bundle marker with NSS while packing,
  # then restores target/release/stakemode.exe. Verify the complete derived
  # image, never a masked hash or a skipped main executable integrity check.
  $mainProofLines = & bun (Join-Path $PSScriptRoot 'stakemode-installed-integrity.ts') (Join-Path $repo 'src-tauri/target/release/stakemode.exe') $app
  $mainProofExit = $LASTEXITCODE
  $mainProofText = [string]::Join("`n", @($mainProofLines))
  if ($mainProofText.Length -gt 8192) { throw 'Installed main integrity proof exceeded its output bound.' }
  $mainProof = $mainProofText | ConvertFrom-Json -AsHashtable
  if ($mainProof -isnot [Collections.IDictionary]) { throw 'Installed main integrity proof must be an object.' }
  $details.mainExecutableIntegrity = $mainProof
  if ($mainProofExit -ne 0 -or $mainProof.passed -isnot [bool] -or $mainProof.passed -ne $true -or $mainProof.method -cne 'exact-pinned-tauri-nsis-marker') { throw 'Installed main differs from its exact pinned NSIS release payload.' }
  if ((Get-FileHash -LiteralPath $sidecarPath -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath (Join-Path $repo 'src-tauri/binaries/stakemode-sidecar-x86_64-pc-windows-msvc.exe') -Algorithm SHA256).Hash) { throw 'Installed sidecar differs from the compiled release payload.' }
  $startInfo = [Diagnostics.ProcessStartInfo]::new($app); $startInfo.UseShellExecute = $false; $startInfo.WorkingDirectory = $runRoot
  foreach ($name in @('ALIASMODE_PLAYWRIGHT_RUNTIME', 'CLOAKBROWSER_BINARY_PATH', 'CLOAKBROWSER_BINARY_SHA256', 'ALIASMODE_FIREFOX_BINARY_PATH', 'ALIASMODE_FIREFOX_BINARY_SHA256', 'STAKEMODE_STATE_ROOT', 'STAKEMODE_SYNC_EXTENSION_ROOT', 'ALIASMODE_DESKTOP_NONCE', 'ALIASMODE_DESKTOP_VERSION')) { [void]$startInfo.Environment.Remove($name) }
  $startInfo.Environment['ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG'] = '1'
  $startInfo.Environment['ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG_PORT'] = [string]$debugPort
  $startInfo.Environment['WEBVIEW2_USER_DATA_FOLDER'] = $webViewRoot
  $desktop = [Diagnostics.Process]::Start($startInfo); Remember-Process $desktop
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(120)
  $health = $null
  $readinessTreeCaptured = $false
  while ([DateTime]::UtcNow -lt $readyDeadline) {
    if (Has-Exited $desktop) { throw 'Installed Tauri desktop exited before readiness.' }
    $desktop.Refresh()
    $nativeTitle = [string]$desktop.MainWindowTitle
    $titleAllowed = $nativeTitle -cin @('StakeMode', 'StakeMode · Browser workspace')
    $titleCategory = if ($nativeTitle -ceq 'StakeMode') { 'product' } elseif ($nativeTitle -ceq 'StakeMode · Browser workspace') { 'workspace' } elseif ($nativeTitle -ceq 'StakeMode service stopped') { 'service-stopped' } elseif ($nativeTitle.Length -eq 0) { 'empty' } else { 'other' }
    $details.nativeReadiness = [ordered]@{ titleCategory = $titleCategory; titleLength = $nativeTitle.Length; windowHandlePresent = $desktop.MainWindowHandle -ne 0 }
    $record = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($desktop.Id)" | Where-Object { $_.Name -eq 'stakemode-sidecar.exe' } | Select-Object -First 1
    if ($record -and -not $sidecar) {
      if (-not ([IO.Path]::GetFullPath($record.ExecutablePath).Equals([IO.Path]::GetFullPath($sidecarPath), [StringComparison]::OrdinalIgnoreCase))) { throw 'Native desktop started a sidecar outside its installed directory.' }
      $sidecar = [Diagnostics.Process]::GetProcessById([int]$record.ProcessId); $null = $sidecar.Handle
      try {
        if ([Math]::Abs(($sidecar.StartTime.ToUniversalTime() - $record.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1 -or
            -not ([IO.Path]::GetFullPath(([StakeModeNativeImage]::Read($sidecar.Handle))).Equals([IO.Path]::GetFullPath($sidecarPath), [StringComparison]::OrdinalIgnoreCase))) { throw 'Sidecar process generation changed before ownership could be bound.' }
      } catch { Record-BindingFailure 'sidecar-identity' 'sidecar' $_; $sidecar.Dispose(); $sidecar = $null; throw 'Sidecar process identity could not be verified.' }
      Remember-Process $sidecar
    }
    if ($sidecar -and $desktop.MainWindowHandle -ne 0) {
      try { $health = Read-LocalJson '/ui/api/health' } catch { $health = $null }
      if ($health -and -not $readinessTreeCaptured) { Wait-BoundOwnedTree ([int][Math]::Max(1, ($readyDeadline - [DateTime]::UtcNow).TotalMilliseconds)); $readinessTreeCaptured = $true }
      if ($health -and $titleAllowed) { break }
    }
    Start-Sleep -Milliseconds 300
  }
  if (-not $health -or -not $sidecar -or $desktop.MainWindowHandle -eq 0) { throw 'Installed native window and packaged service did not become ready.' }
  if (-not $titleAllowed) { throw 'Installed native window did not reach an expected title within its readiness bound.' }
  if ($health.ok -ne $true -or $health.product -cne 'StakeMode' -or $health.version -cne $version -or $health.pid -ne $sidecar.Id -or $health.activeBrowserCount -ne 0 -or $health.instance -notmatch '^[a-f0-9]{64}$') { throw 'Installed health failed version, nonce, PID or zero-profile proof.' }
  if (-not ([IO.Path]::GetFullPath([string]$health.root).Equals([IO.Path]::GetFullPath($appDataRoot), [StringComparison]::OrdinalIgnoreCase))) { throw 'Installed desktop used an unexpected data root.' }
  $details.nativeWindowCreated = $true; $details.installedSidecarVerified = $true
  $details.desktopPid = $desktop.Id; $details.sidecarPid = $sidecar.Id
  $headers = @{ 'X-StakeMode-Workspace' = '1' }
  $bootstrap = Read-LocalJson '/workspace/api/bootstrap' $headers
  if ([string]::IsNullOrEmpty($bootstrap.token)) { throw 'Installed service did not issue a dashboard token.' }
  $headers.Authorization = "Bearer $($bootstrap.token)"
  $snapshot = Read-LocalJson '/workspace/api/snapshot' $headers
  if (@($snapshot.snapshot.profiles).Count -ne 0) { throw 'Installed GUI smoke must have zero browser profiles.' }
  $details.webViewOwnership = [ordered]@{}
  $webViewIdentity = Assert-OwnedWebViewEndpoint 'beforeInspection'
  $screenshot = Join-Path (Split-Path $reportFile -Parent) 'stakemode-screenshots/installed-tauri.png'
  Write-Host 'StakeMode installed smoke: inspecting the actual native WebView2.'
  & bun (Join-Path $PSScriptRoot 'stakemode-installed-ui.mjs') (Join-Path $installRoot 'playwright') $debugPort $screenshot
  if ($LASTEXITCODE -ne 0) { throw 'Installed Tauri WebView did not render the real workspace.' }
  [void](Assert-OwnedWebViewEndpoint 'afterInspection' $webViewIdentity)
  $desktop.Refresh()
  if ($desktop.MainWindowTitle -cnotin @('StakeMode', 'StakeMode · Browser workspace')) { throw 'Installed native window title changed after renderer verification.' }
  $renderHealth = Read-LocalJson '/ui/api/health'
  if ((Has-Exited $sidecar) -or $renderHealth.ok -ne $true -or $renderHealth.product -cne 'StakeMode' -or $renderHealth.version -cne $version -or
      $renderHealth.pid -ne $sidecar.Id -or $renderHealth.activeBrowserCount -ne 0 -or $renderHealth.instance -cne $health.instance -or
      -not ([IO.Path]::GetFullPath([string]$renderHealth.root).Equals([IO.Path]::GetFullPath($appDataRoot), [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Installed service identity changed during renderer verification.'
  }
  $details.installedWebViewRendered = $true
  if (-not $desktop.CloseMainWindow()) { throw 'Installed native window did not accept a close request.' }
  if (-not $desktop.WaitForExit(40000) -or $desktop.ExitCode -ne 0) { throw 'Installed native window did not exit cleanly after CloseMainWindow.' }
  $details.gracefulNativeClose = $true
  foreach ($owned in $ownedProcesses) { if (-not (Has-Exited $owned) -and -not $owned.WaitForExit(30000)) { throw 'An owned installed desktop child survived graceful native shutdown.' } }
  $details.ownedProcessesExited = $true
  try { Read-LocalJson '/ui/api/health' | Out-Null; throw 'Installed service still answers after native shutdown.' } catch {
    if ($_.Exception.Message -eq 'Installed service still answers after native shutdown.') { throw }
  }
  Write-Host 'StakeMode installed smoke: native window, renderer and service shut down cleanly.'
  $passed = $true
} catch { $failure = $_.Exception.Message }
finally {
  # Bind any later-created native children before failure cleanup, without
  # adding process-service scans to every startup readiness poll.
  try {
    if ($desktop -and -not (Has-Exited $desktop)) { Wait-BoundOwnedTree }
  } catch { $cleanupFailures.Add('Owned desktop descendants could not be rebound before failure cleanup.') }
  # Failure cleanup uses held kernel process handles, never image names or a PID rediscovery kill.
  foreach ($owned in @($ownedProcesses.ToArray()) | Sort-Object Id -Descending) {
    try { if (-not (Has-Exited $owned)) { $owned.Kill(); if (-not $owned.WaitForExit(10000)) { throw 'Owned process did not exit during smoke cleanup.' } } } catch { $cleanupFailures.Add($_.Exception.Message) }
  }
  if ($script:unresolvedObservedProcesses.Count) {
    try { Wait-ObservedAbsence } catch { $cleanupFailures.Add('Previously observed desktop children remain unconfirmed after cleanup.') }
  }
  if ($installationAttempted) {
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      try {
        # NSIS _?= prevents the bootstrap/self-copy exit from masquerading as completion.
        # https://nsis.sourceforge.io/Docs/Chapter3.html#3.2.2
        $ownedUninstaller = Join-Path $runRoot 'owned-uninstall.exe'
        Copy-Item -LiteralPath $uninstaller -Destination $ownedUninstaller
        if ((Get-FileHash -LiteralPath $ownedUninstaller -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash) { throw 'Owned uninstaller copy failed integrity verification.' }
        Run-OwnedInstaller $ownedUninstaller @('/S', "_?=$installRoot") 120000
        if ((Test-Path -LiteralPath (Join-Path $installRoot 'stakemode.exe')) -or (Test-Path -LiteralPath (Join-Path $installRoot 'stakemode-sidecar.exe'))) { throw 'Installed executable survived completed uninstallation.' }
        $remainingRegistration = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'StakeMode' })
        if ($remainingRegistration.Count) { throw 'StakeMode uninstall registration survived completed uninstallation.' }
        $details.uninstalled = $true
      } catch { $cleanupFailures.Add($_.Exception.Message) }
    } elseif ($details.installed) { $cleanupFailures.Add('Installed NSIS uninstaller is missing.') }
  }
  foreach ($root in $ownedRoots) {
    try {
      $marker = Join-Path $root '.stakemode-smoke-owner'
      if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or [IO.File]::ReadAllText($marker) -cne $runId) { throw 'Owned smoke data marker changed; cleanup refused.' }
      Remove-Item -LiteralPath $root -Recurse -Force
    } catch { $cleanupFailures.Add($_.Exception.Message) }
  }
  $cleanupConfirmed = $cleanupFailures.Count -eq 0 -and $script:unresolvedObservedProcesses.Count -eq 0 -and (-not $installationAttempted -or $details.uninstalled -eq $true)
  if ($cleanupFailures.Count) { $details.cleanupErrors = $cleanupFailures.ToArray() }
  $passed = $passed -and $cleanupConfirmed
  $http.Dispose(); $httpHandler.Dispose()
  foreach ($owned in $ownedProcesses) { $owned.Dispose() }
  $details.passed = $passed; $details.finishedAt = [DateTime]::UtcNow.ToString('o')
  if ($failure) { $details.error = $failure }
  $report.finishedAt = $details.finishedAt
  $report.installedDesktop = $details
  $report.checks = @([ordered]@{ name = 'actual installed NSIS Tauri window, rendered WebView and owned shutdown'; passed = $passed; milliseconds = [int](([DateTime]::UtcNow - $started).TotalMilliseconds); details = $details })
  $report.passed = $passed
  $report.cleanupConfirmed = $cleanupConfirmed
  [IO.File]::WriteAllText($reportFile, ($report | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))
}
if (-not $passed) { throw "Installed StakeMode smoke failed: $failure $($cleanupFailures -join '; ')" }
Write-Host 'PASS actual installed StakeMode NSIS/Tauri GUI smoke'
