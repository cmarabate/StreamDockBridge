# verify-service-startup.ps1
#
# Proves that the logon registration written by install-service-startup.ps1 is intact
# and that the service it launches is actually up. Read-only unless -Launch or -Restart
# is given. Exit code 0 means every check passed; 1 means at least one failed.
#
# Why this exists: a hidden logon launcher has no console to report a failure on. On
# 2026-09-04 the Startup entry existed, nothing was listening on the port, and the only
# way to tell was to notice Stream Deck buttons failing. This script turns "is startup
# actually registered and working?" into one command with a yes/no answer.
#
#   .\verify-service-startup.ps1            # inspect and report
#   .\verify-service-startup.ps1 -Launch    # if the service is down, start it through the
#                                           # installed launcher (the exact artifact logon
#                                           # runs) and verify it comes up hidden
#   .\verify-service-startup.ps1 -Restart   # stop the running service, then do -Launch
[CmdletBinding()]
param(
    [switch]$Launch,
    [switch]$Restart,
    [int]$Port = 17337,
    [int]$StartupTimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

$startupDir = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
$launcherPath = Join-Path $startupDir 'StreamDockBridgeService.vbs'
$legacyCmdPath = Join-Path $startupDir 'StreamDockBridgeService.cmd'
$expectedDist = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'packages\service\dist\index.js'))
$logPath = Join-Path $env:APPDATA 'StreamDockBridge\service.log'
$healthUrl = "http://127.0.0.1:$Port/health"

$results = New-Object System.Collections.Generic.List[object]
function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail)
    $results.Add([pscustomobject]@{
        Check  = $Name
        Result = $(if ($Ok) { 'PASS' } else { 'FAIL' })
        Detail = $Detail
    }) | Out-Null
}

# ---------------------------------------------------------------------------
# Registration: the file Explorer will run at logon.
# ---------------------------------------------------------------------------
$launcherOk = Test-Path $launcherPath
Add-Check 'Launcher present' $launcherOk $launcherPath

# Two entries would race for the port; the .cmd also put a console on the desktop.
Add-Check 'No superseded .cmd entry' (-not (Test-Path $legacyCmdPath)) $legacyCmdPath

$launcher = $null
if ($launcherOk) {
    $bytes = [System.IO.File]::ReadAllBytes($launcherPath)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    Add-Check 'Launcher has no BOM' (-not $hasBom) 'a BOM ahead of the first line is a parse error for the script host'

    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $pattern = '""""(?<node>[^"]+)"" ""(?<script>[^"]+)"" > ""(?<log>[^"]+)"" 2>&1""", (?<style>\d+), False'
    $match = [regex]::Match($text, $pattern)
    if ($match.Success) {
        $launcher = [pscustomobject]@{
            Node   = $match.Groups['node'].Value
            Script = $match.Groups['script'].Value
            Log    = $match.Groups['log'].Value
            Style  = [int]$match.Groups['style'].Value
        }
        Add-Check 'Launcher command parses' $true "node=$($launcher.Node) script=$($launcher.Script)"
        Add-Check 'Launcher starts hidden (window style 0)' ($launcher.Style -eq 0) "window style $($launcher.Style)"
        Add-Check 'Launcher node.exe exists' (Test-Path $launcher.Node) $launcher.Node
        Add-Check 'Launcher service script exists' (Test-Path $launcher.Script) $launcher.Script

        # The launcher belongs to exactly one checkout. A different path means this repo's
        # install was superseded by another clone, and "yarn build" here changes nothing.
        $sameCheckout = [string]::Equals(
            [System.IO.Path]::GetFullPath($launcher.Script),
            $expectedDist,
            [System.StringComparison]::OrdinalIgnoreCase)
        Add-Check 'Launcher targets this checkout' $sameCheckout "expected $expectedDist"
        Add-Check 'Launcher log path matches' ([string]::Equals($launcher.Log, $logPath, [System.StringComparison]::OrdinalIgnoreCase)) $launcher.Log
    } else {
        Add-Check 'Launcher command parses' $false 'shell.Run line not in the shape install-service-startup.ps1 writes; reinstall'
    }
}

# ---------------------------------------------------------------------------
# Runtime: the process the launcher produces, and the port it must own.
# ---------------------------------------------------------------------------
function Get-ServiceProcesses {
    param([string]$ScriptPath)
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ScriptPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

function Test-Health {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
        return ($response.status -eq 'ok' -and $response.service -eq 'StreamDockBridge')
    } catch {
        return $false
    }
}

function Wait-Health {
    param([int]$Seconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (Test-Health) { return $true }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    return Test-Health
}

$targetScript = if ($launcher) { $launcher.Script } else { $expectedDist }

if ($Restart) {
    foreach ($proc in @(Get-ServiceProcesses $targetScript)) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped service process (PID $($proc.ProcessId)) for restart."
    }
    Start-Sleep -Seconds 1
    $Launch = $true
}

$launched = $false
if ($Launch -and $launcherOk -and -not (Test-Health)) {
    # Through wscript.exe on the installed .vbs, which is exactly what Explorer does with
    # a Startup-folder script at logon. Anything else would prove a different artifact.
    Write-Host "Service is not answering; launching through $launcherPath ..."
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$launcherPath`"" -WindowStyle Hidden
    $launched = $true
    $cameUp = Wait-Health -Seconds $StartupTimeoutSeconds
    Add-Check "Launcher brings the service up within ${StartupTimeoutSeconds}s" $cameUp $healthUrl
}

$processes = @(Get-ServiceProcesses $targetScript)
Add-Check 'Exactly one service process' ($processes.Count -eq 1) "found $($processes.Count) node.exe running $targetScript"

$servicePid = $null
if ($processes.Count -ge 1) {
    $servicePid = $processes[0].ProcessId
    $started = $processes[0].CreationDate
    Add-Check 'Service process' $true "PID $servicePid started $started"

    # A hidden launcher must leave no console on the desktop. MainWindowHandle is zero
    # for a process whose window is hidden or absent, for the service and for the cmd.exe
    # that wires its output to the log.
    $visible = @()
    foreach ($id in @($servicePid, $processes[0].ParentProcessId)) {
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -ne 0) { $visible += "$($p.ProcessName) (PID $id)" }
    }
    Add-Check 'No visible console window' ($visible.Count -eq 0) $(if ($visible.Count) { $visible -join ', ' } else { 'service and its cmd.exe parent are windowless' })
}

$listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count -eq 0) {
    Add-Check "Port $Port listening" $false 'nothing is listening'
} else {
    $owner = $listener[0].OwningProcess
    $ownedByService = ($null -ne $servicePid) -and ($owner -eq $servicePid)
    Add-Check "Port $Port listening" $true "owned by PID $owner ($($listener[0].LocalAddress))"
    Add-Check "Port $Port owned by the service process" $ownedByService $(if ($ownedByService) { "PID $owner" } else { "PID $owner is not the service; another process holds the port" })
}

Add-Check 'Health endpoint answers' (Test-Health) $healthUrl

$logExists = Test-Path $logPath
Add-Check 'Service log present' $logExists $logPath

# ---------------------------------------------------------------------------
# Report.
# ---------------------------------------------------------------------------
$results | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Write-Host

$failed = @($results | Where-Object { $_.Result -eq 'FAIL' })
if ($failed.Count -gt 0 -and $logExists) {
    Write-Host "--- tail of $logPath ---"
    Get-Content $logPath -Tail 20 | ForEach-Object { Write-Host "  $_" }
}

if ($failed.Count -eq 0) {
    Write-Host "StreamDockBridge logon startup: OK ($($results.Count) checks passed$(if ($launched) { ', service launched through the installed launcher' }))."
    exit 0
}

Write-Host "StreamDockBridge logon startup: $($failed.Count) check(s) FAILED. Run install-service-startup.ps1 from this checkout to repair the registration."
exit 1
