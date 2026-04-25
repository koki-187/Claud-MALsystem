# MAL Task Scheduler - 新規タスク登録スクリプト
# TERASS タスクは既存。RSS と LocalScraper を追加登録する。

$schtasks = 'C:\Windows\System32\schtasks.exe'
$user = $env:USERDOMAIN + '\' + $env:USERNAME

Write-Host "=== MAL Task Scheduler 登録 ===" -ForegroundColor Cyan
Write-Host "ユーザー: $user"
Write-Host ""

# MAL-Rakumachi-RSS (毎日 04:30)
Write-Host "[1/2] MAL-Rakumachi-RSS (毎日 04:30)" -ForegroundColor Yellow
& $schtasks /DELETE /TN "MAL-Rakumachi-RSS" /F 2>$null
$result1 = & $schtasks /CREATE /TN "MAL-Rakumachi-RSS" `
    /TR "C:\Users\reale\Downloads\mal-worker\scripts\run-rakumachi-rss.bat" `
    /SC DAILY /ST 04:30 `
    /RU $user `
    /RL HIGHEST /F 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [OK] 登録成功" -ForegroundColor Green
} else {
    Write-Host "  [WARN] HIGHEST 失敗、通常権限で再試行..." -ForegroundColor Yellow
    $result1b = & $schtasks /CREATE /TN "MAL-Rakumachi-RSS" `
        /TR "C:\Users\reale\Downloads\mal-worker\scripts\run-rakumachi-rss.bat" `
        /SC DAILY /ST 04:30 `
        /RU $user /F 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] 登録成功 (通常権限)" -ForegroundColor Green
    } else {
        Write-Host "  [ERROR] 登録失敗: $result1b" -ForegroundColor Red
    }
}

# MAL-LocalScraper (毎日 04:45)
Write-Host "[2/2] MAL-LocalScraper (毎日 04:45)" -ForegroundColor Yellow
& $schtasks /DELETE /TN "MAL-LocalScraper" /F 2>$null
$result2 = & $schtasks /CREATE /TN "MAL-LocalScraper" `
    /TR "C:\Users\reale\Downloads\mal-worker\scripts\run-local-scraper.bat" `
    /SC DAILY /ST 04:45 `
    /RU $user `
    /RL HIGHEST /F 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [OK] 登録成功" -ForegroundColor Green
} else {
    Write-Host "  [WARN] HIGHEST 失敗、通常権限で再試行..." -ForegroundColor Yellow
    $result2b = & $schtasks /CREATE /TN "MAL-LocalScraper" `
        /TR "C:\Users\reale\Downloads\mal-worker\scripts\run-local-scraper.bat" `
        /SC DAILY /ST 04:45 `
        /RU $user /F 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] 登録成功 (通常権限)" -ForegroundColor Green
    } else {
        Write-Host "  [ERROR] 登録失敗: $result2b" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "=== 登録確認 ===" -ForegroundColor Cyan
& $schtasks /Query /TN "MAL-Rakumachi-RSS" /FO LIST 2>&1 | Select-String "タスク名|状態|次回実行時刻|Task Name|Status|Next Run"
Write-Host ""
& $schtasks /Query /TN "MAL-LocalScraper" /FO LIST 2>&1 | Select-String "タスク名|状態|次回実行時刻|Task Name|Status|Next Run"
Write-Host ""
Write-Host "=== 全MALタスク一覧 ===" -ForegroundColor Cyan
& $schtasks /Query /FO TABLE 2>&1 | Select-String "MAL|TERASS"
