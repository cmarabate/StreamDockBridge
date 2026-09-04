# uninstall-service-startup.ps1
$startupDir = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')

# Both names are removed: the .vbs this repo installs now, and the .cmd earlier installs
# left behind. Uninstalling has to clear every entry an install of this repo could have
# written, or "uninstall" silently leaves one of them still launching at logon.
$targets = @(
    (Join-Path $startupDir "StreamDockBridgeService.vbs"),
    (Join-Path $startupDir "StreamDockBridgeService.cmd")
)

$removed = $false
foreach ($target in $targets) {
    if (Test-Path $target) {
        Remove-Item -Path $target -Force
        Write-Host "Successfully uninstalled startup entry from: $target"
        $removed = $true
    }
}
if (-not $removed) {
    Write-Host "No StreamDockBridge startup entry was found in $startupDir"
}

# Stop any running service process
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*packages\service\dist\index.js*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "Stopped background service process."
