# 運用前チェックスクリプト
$results = @{}

# 1. Chrome CDP
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    $j = $r.Content | ConvertFrom-Json
    $results['CDP'] = "ONLINE: $($j.Browser)"
} catch {
    $results['CDP'] = "OFFLINE"
}

# 2. Node.js
$nv = (node --version 2>&1)
$results['NODE'] = $nv

# 3. playwright
$pw = Test-Path 'C:\Users\reale\Downloads\mal-worker\node_modules\playwright'
$results['PLAYWRIGHT'] = if ($pw) { "INSTALLED" } else { "MISSING" }

# 4. .env
$ev = Test-Path 'C:\Users\reale\Downloads\mal-worker\.env'
$results['ENV_FILE'] = if ($ev) { "EXISTS" } else { "MISSING" }

if ($ev) {
    # @() forces array even when file has only 1 line (prevents Char indexing bug)
    $lines = @(Get-Content 'C:\Users\reale\Downloads\mal-worker\.env')
    $sec = @($lines | Where-Object { $_ -match '^ADMIN_SECRET=.+' })
    if ($sec.Count -gt 0) {
        $val = ($sec[0].ToString() -replace '^ADMIN_SECRET=', '').Trim()
        $results['ADMIN_SECRET'] = "SET (len=$($val.Length))"
    } else {
        $results['ADMIN_SECRET'] = "MISSING"
    }
}

# 5. Task Scheduler
try {
    $dt = Get-ScheduledTask -TaskName 'TERASS_AutoImport_Daily' -ErrorAction Stop
    $di = $dt | Get-ScheduledTaskInfo
    $results['TASK_DAILY'] = "State=$($dt.State) NextRun=$($di.NextRunTime) LastResult=$($di.LastTaskResult)"
} catch { $results['TASK_DAILY'] = "NOT FOUND" }

try {
    $wt = Get-ScheduledTask -TaskName 'TERASS-PICKS-Weekly-Backfill' -ErrorAction Stop
    $wi = $wt | Get-ScheduledTaskInfo
    $results['TASK_WEEKLY'] = "State=$($wt.State) NextRun=$($wi.NextRunTime) LastResult=$($wi.LastTaskResult)"
} catch { $results['TASK_WEEKLY'] = "NOT FOUND" }

# 6. Chrome exe
$results['CHROME_EXE'] = if (Test-Path 'C:\Program Files\Google\Chrome\Application\chrome.exe') { "EXISTS" } else { "MISSING" }

# 7. Git bin bash
$results['GIT_BASH'] = if (Test-Path 'C:\Program Files\Git\bin\bash.exe') { "EXISTS" } else { "MISSING" }

# 8. key scripts
$scripts = @(
    'C:\Users\reale\Downloads\mal-worker\scripts\run-auto-import.ps1',
    'C:\Users\reale\Downloads\mal-worker\scripts\auto-import-terass.sh',
    'C:\Users\reale\Downloads\mal-worker\scripts\extract-terass.mjs',
    'C:\Users\reale\Downloads\mal-worker\scripts\terass_convert_and_import.mjs',
    'C:\Users\reale\Downloads\mal-worker\scripts\run-weekly-backfill.sh',
    'C:\Users\reale\Downloads\mal-worker\scripts\run-weekly-backfill.bat'
)
foreach ($s in $scripts) {
    $name = Split-Path $s -Leaf
    $results["SCRIPT_$name"] = if (Test-Path $s) { "OK" } else { "MISSING" }
}

# 9. TERASS CSV dir
$csvDir = 'C:\Users\reale\Downloads\TERASS_MAL_converted'
if (Test-Path $csvDir) {
    $csvCount = (Get-ChildItem $csvDir -Filter 'MAL_ALL_*.csv' 2>$null).Count
    $results['CSV_CONVERTED'] = "EXISTS ($csvCount files)"
} else {
    $results['CSV_CONVERTED'] = "DIR MISSING"
}

# 10. Log file (previous run)
$logFile = 'C:\Users\reale\Downloads\terass_cron.log'
if (Test-Path $logFile) {
    $size = [math]::Round((Get-Item $logFile).Length / 1KB, 1)
    $last = (Get-Content $logFile -Tail 3) -join ' | '
    $results['CRON_LOG'] = "EXISTS ${size}KB last: $last"
} else {
    $results['CRON_LOG'] = "NOT YET (first run pending)"
}

# --- 出力 ---
foreach ($k in ($results.Keys | Sort-Object)) {
    Write-Host ("{0,-30} {1}" -f $k, $results[$k])
}
