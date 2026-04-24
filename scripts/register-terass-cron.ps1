# =============================================================================
# register-terass-cron.ps1 — TERASS_AutoImport_Daily Task Scheduler 登録
# =============================================================================
# 毎日 02:00 に run-auto-import.ps1 を /RL HIGHEST /RU SYSTEM で実行するタスクを登録。
# 既存タスクがあれば置換 (冪等)。管理者権限が無い場合は WARNING を出して継続。
# =============================================================================

$ErrorActionPreference = 'Continue'

$TaskName    = 'TERASS_AutoImport_Daily'
$ProjectDir  = 'C:\Users\reale\Downloads\mal-worker'
$ScriptPath  = Join-Path $ProjectDir 'scripts\run-auto-import.ps1'
$PsExe       = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$RunTime     = '02:00'

function Write-Status {
    param([string]$Level, [string]$Message)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Host "[$ts] [$Level] $Message"
}

# --- 管理者権限チェック ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Status 'WARNING' '管理者権限なしで実行中。/RU SYSTEM の登録には管理者権限が必要です。'
    Write-Status 'WARNING' '権限エラーが発生した場合は、管理者として PowerShell を開き直してください。'
}

# --- 既存タスクの削除 (冪等) ---
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Status 'INFO' "既存タスク '$TaskName' を削除して再登録します..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

# --- タスク定義 ---
$action = New-ScheduledTaskAction `
    -Execute $PsExe `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`"" `
    -WorkingDirectory $ProjectDir

$trigger = New-ScheduledTaskTrigger -Daily -At $RunTime

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false `
    -MultipleInstances IgnoreNew

# SYSTEM アカウントでは Chrome CDP (GUI) が起動できないため、
# ログオン中ユーザー ($env:USERNAME) で実行。
# "ユーザーがログオンしているときのみ実行" → Chrome が画面を使える。
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -RunLevel Highest `
    -LogonType Interactive

Write-Status 'INFO' "実行ユーザー: $currentUser (Chrome CDP GUI が必要なため SYSTEM は使用しない)"

# --- 登録 ---
try {
    Register-ScheduledTask `
        -TaskName  $TaskName `
        -Action    $action `
        -Trigger   $trigger `
        -Settings  $settings `
        -Principal $principal `
        -Force `
        -ErrorAction Stop

    Write-Status 'INFO' "タスク '$TaskName' の登録に成功しました (ユーザー: $currentUser)。"
} catch {
    Write-Status 'ERROR' "タスク登録に失敗しました: $($_.Exception.Message)"
    Write-Status 'ERROR' '管理者権限で再実行してください。'
    exit 1
}

# --- 登録確認 ---
Write-Status 'INFO' '--- schtasks /Query 確認 ---'
& schtasks /Query /TN $TaskName /FO LIST /V 2>&1 | ForEach-Object {
    Write-Host $_
}

Write-Status 'INFO' '登録完了。毎日 02:00 (ユーザーログオン中) に TERASS 自動インポートが実行されます。'
Write-Status 'INFO' '重要: Chrome CDP は GUI セッションが必要です。PC をログオンしたまま (スリープ可) にしてください。'
