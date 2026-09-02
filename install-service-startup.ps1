# install-service-startup.ps1
$startupDir = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
$targetCmd = Join-Path $startupDir "StreamDockBridgeService.cmd"
$serviceDistPath = Join-Path $PSScriptRoot "packages\service\dist\index.js"
$nodePath = (Get-Command node).Source

if (-not (Test-Path $serviceDistPath)) {
    Write-Error "Service dist file not found at $serviceDistPath. Run 'yarn build' first."
    exit 1
}

$cmdContent = @"
@echo off
"$nodePath" "$serviceDistPath"
"@

Set-Content -Path $targetCmd -Value $cmdContent -Encoding utf8
Write-Host "Successfully installed Windows logon startup script with absolute paths to: $targetCmd"

# Start service process for current session using installed script
Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$targetCmd`"" -WindowStyle Hidden
Write-Host "StreamDockBridge background service launched from installed startup script."
