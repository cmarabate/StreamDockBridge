# uninstall-service-startup.ps1
$startupDir = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
$targetCmd = Join-Path $startupDir "StreamDockBridgeService.cmd"

if (Test-Path $targetCmd) {
    Remove-Item -Path $targetCmd -Force
    Write-Host "Successfully uninstalled startup script from: $targetCmd"
} else {
    Write-Host "Startup script was not found at $targetCmd"
}

# Stop any running service process
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*packages\service\dist\index.js*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "Stopped background service process."
