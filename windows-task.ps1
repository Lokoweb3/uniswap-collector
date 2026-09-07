# Registers a Windows scheduled task that starts WSL and runs the collector.
#
# More reliable than a systemd timer inside WSL, because Task Scheduler can
# start the distro. A timer inside WSL only fires if WSL happens to be running.
#
# Run from PowerShell on the Windows side:
#   powershell -ExecutionPolicy Bypass -File .\windows-task.ps1

param(
    [string]$Distro   = "Ubuntu",
    [string]$LinuxDir = "/home/$env:USERNAME/uniswap-collector",
    [string]$Mode     = "full",
    [string]$At       = "9am"
)

$ErrorActionPreference = "Stop"

$cmd = "cd '$LinuxDir' && ./run-collector.sh $Mode --quiet"
$action = New-ScheduledTaskAction -Execute "wsl.exe" `
    -Argument "-d $Distro -- bash -lc `"$cmd`""

$trigger  = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName "LP Fee Collector" `
    -Action $action -Trigger $trigger -Settings $settings -Force

Write-Host ""
Write-Host "Registered. It runs as $Distro and skips quietly when the keystore is locked."
Write-Host "Arm it inside WSL with:  ./unlock.sh 1440"
