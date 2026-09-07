# Registers a Windows scheduled task that keeps the WSL distro alive and the
# dashboard, Tailscale tunnel and remote MCP server running.
#
# Why: WSL terminates a distro a few seconds after the last wsl.exe session
# closes, which kills every nohup'd server inside it. This task keeps one
# hidden wsl.exe session attached at all times. On each start it runs
# start-all.sh (idempotent), then blocks forever. If the distro dies anyway,
# Task Scheduler restarts the task a minute later, which reboots the distro
# and brings the servers back.
#
# Run from PowerShell on the Windows side:
#   powershell -ExecutionPolicy Bypass -File .\windows-keepalive.ps1
# or from inside WSL:
#   powershell.exe -ExecutionPolicy Bypass -File "$(wslpath -w ./windows-keepalive.ps1)"

param(
    [string]$Distro   = "Ubuntu",
    [string]$LinuxDir = "/home/<user>/uniswap-collector",
    [string]$TaskName = "LP Dashboard Keepalive"
)

$ErrorActionPreference = "Stop"

$cmd = "cd '$LinuxDir' && ./start-all.sh; exec sleep infinity"
# conhost --headless runs wsl.exe without a console window on the desktop.
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless wsl.exe -d $Distro -- bash -lc `"$cmd`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Registered and started '$TaskName'. It runs at every logon of $env:USERNAME."
Write-Host "Check:  Get-ScheduledTask '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Stop:   Stop-ScheduledTask '$TaskName'   (the distro then shuts down when your last terminal closes)"
