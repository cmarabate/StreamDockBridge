# uninstall-service-startup.ps1
$taskName = "StreamDockBridgeService"

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Successfully uninstalled scheduled task: $taskName"
} else {
    Write-Host "Task $taskName was not found."
}
