# register-weekly-backfill.ps1 — 週次バックフィル Task Scheduler 登録
# 管理者権限の PowerShell で実行してください
$taskName  = 'TERASS-PICKS-Weekly-Backfill'
$bashExe   = 'C:\Program Files\Git\bin\bash.exe'
$scriptPath = 'C:/Users/reale/Downloads/mal-worker/scripts/run-weekly-backfill.sh'
$workDir   = 'C:\Users\reale\Downloads\mal-worker'

$action = New-ScheduledTaskAction `
  -Execute $bashExe `
  -Argument "-lc `"cd '$workDir' && bash scripts/run-weekly-backfill.sh`"" `
  -WorkingDirectory $workDir

# 毎週日曜 03:30 実行 (日次が 02:00 完了後)
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '03:30AM'

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable

$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -RunLevel Highest -LogonType Interactive

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force |
  Format-List TaskName, State

Write-Host "週次バックフィル登録完了: 毎週日曜 03:30 (ユーザー: $currentUser)" -ForegroundColor Green
Write-Host "注意: Chrome CDP (GUI) が必要。ログオン維持が必要です。" -ForegroundColor Yellow
