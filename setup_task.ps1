# ============================================================
#  Registers a Windows Scheduled Task that runs run_daily.bat
#  WHETHER OR NOT THE USER IS LOGGED ON:
#    - at system startup (boot, before any login)
#    - every day at a fixed time (default 08:00, catches up if PC was off)
#    - at logon (extra safety)
#
#  REQUIRES AN ELEVATED (Administrator) PowerShell.
#  Right-click PowerShell -> "Run as administrator", then:
#     cd D:\Fear_Greed
#     .\setup_task.ps1                 # default: S4U (no password needed)
#     .\setup_task.ps1 -WithPassword   # if git push fails when logged off,
#                                      #   re-run this to store your Windows password
#     .\setup_task.ps1 -Remove         # unregister
# ============================================================
param(
  [string]$Time = "08:00",
  [string]$TaskName = "FearGreedDashboard",
  [switch]$WithPassword,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bat  = Join-Path $here "run_daily.bat"

# must be elevated
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  throw "관리자 권한이 필요합니다. PowerShell을 '관리자 권한으로 실행' 후 다시 시도하세요."
}

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'."
  return
}
if (-not (Test-Path $bat)) { throw "run_daily.bat not found at $bat" }

# clean up the interim non-elevated tasks if they exist
foreach ($t in @("FearGreedDashboard_Daily","FearGreedDashboard_Logon")) {
  Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
}

$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$bat`"" -WorkingDirectory $here
$trigs   = @(
  New-ScheduledTaskTrigger -AtStartup,
  (New-ScheduledTaskTrigger -Daily -At $Time),
  (New-ScheduledTaskTrigger -AtLogOn)
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
              -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)

$user = "$env:USERDOMAIN\$env:USERNAME"

if ($WithPassword) {
  $cred = Get-Credential -UserName $user -Message "Windows 로그인 비밀번호 (작업이 로그오프 상태에서도 실행되도록 저장)"
  $principal = New-ScheduledTaskPrincipal -UserId $cred.UserName -LogonType Password -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigs -Settings $settings `
    -Principal $principal -User $cred.UserName `
    -Password $cred.GetNetworkCredential().Password `
    -Description "Daily Fear & Greed data refresh + GitHub push (runs whether logged on or not)" -Force | Out-Null
} else {
  # S4U: runs whether or not the user is logged on, no stored password.
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigs -Settings $settings `
    -Principal $principal `
    -Description "Daily Fear & Greed data refresh + GitHub push (runs whether logged on or not)" -Force | Out-Null
}

Write-Host "Registered '$TaskName' to run run_daily.bat at startup + daily $Time + logon (whether logged on or not)."
Write-Host "Test now:  Start-ScheduledTask -TaskName $TaskName ; Get-Content '$here\run.log' -Tail 15"
Write-Host "If git push fails while logged off, re-run:  .\setup_task.ps1 -WithPassword"
