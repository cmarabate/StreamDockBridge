# install-service-startup.ps1
$taskName = "StreamDockBridgeService"
$serviceDistPath = Join-Path $PSScriptRoot "packages\service\dist\index.js"
$nodePath = (Get-Command node).Source

if (-not (Test-Path $serviceDistPath)) {
    Write-Error "Service dist file not found at $serviceDistPath. Run 'yarn build' first."
    exit 1
}

$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$serviceDistPath`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "StreamDockBridge Background Service" -Force | Out-Null

Write-Host "Successfully installed scheduled task: $taskName"
Start-ScheduledTask -TaskName $taskName
Write-Host "Service task started."
