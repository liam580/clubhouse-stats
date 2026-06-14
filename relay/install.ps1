# Run from PowerShell **as Administrator** in the relay folder:
#   .\install.ps1
#
# Registers a Windows scheduled task `ClubhouseRelay` that runs relay.py
# at system startup as SYSTEM, auto-restarts on failure.

$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$relay  = Join-Path $here 'relay.py'
$python = (Get-Command python -ErrorAction SilentlyContinue).Source

if (-not $python) {
    Write-Host 'Python is not on PATH. Install Python 3.8+ from python.org' -ForegroundColor Red
    Write-Host "(check 'Add Python to PATH' during install), then rerun this script." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $relay)) {
    Write-Host "relay.py not found next to install.ps1 (looked at $relay)" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $here '.env'))) {
    Write-Host 'No .env file next to relay.py. Copy .env.example to .env and fill it in first.' -ForegroundColor Yellow
    exit 1
}

$action    = New-ScheduledTaskAction    -Execute $python -Argument "`"$relay`"" -WorkingDirectory $here
$trigger   = New-ScheduledTaskTrigger   -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount    999 `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'ClubhouseRelay' `
    -Action    $action    `
    -Trigger   $trigger   `
    -Principal $principal `
    -Settings  $settings  `
    -Force | Out-Null

Write-Host 'Installed. Starting ClubhouseRelay now...' -ForegroundColor Green
Start-ScheduledTask -TaskName 'ClubhouseRelay'
Write-Host ''
Write-Host 'Useful commands:' -ForegroundColor Cyan
Write-Host '  Get-ScheduledTask -TaskName ClubhouseRelay | Get-ScheduledTaskInfo'
Write-Host '  Stop-ScheduledTask  -TaskName ClubhouseRelay'
Write-Host '  Unregister-ScheduledTask -TaskName ClubhouseRelay -Confirm:$false'
