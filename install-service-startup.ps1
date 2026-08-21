# install-service-startup.ps1
$startupDir = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
$targetCmd = Join-Path $startupDir "StreamDockBridgeService.cmd"
$sourceCmd = Join-Path $PSScriptRoot "start-service.cmd"

if (-not (Test-Path $sourceCmd)) {
    Write-Error "source start-service.cmd not found at $sourceCmd"
    exit 1
}

Copy-Item -Path $sourceCmd -Destination $targetCmd -Force
Write-Host "Successfully installed Windows logon startup script to: $targetCmd"

# Start service process for current session
Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$sourceCmd`"" -WindowStyle Hidden
Write-Host "StreamDockBridge background service launched."
