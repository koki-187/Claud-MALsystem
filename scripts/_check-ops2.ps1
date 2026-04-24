# ADMIN_SECRET actual length
# NOTE: @() forces array even when file has only 1 line (prevents Char indexing bug)
$lines = @(Get-Content 'C:\Users\reale\Downloads\mal-worker\.env')
$sec = @($lines | Where-Object { $_ -match '^ADMIN_SECRET=' })
if ($sec.Count -gt 0) {
    $val = ($sec[0].ToString() -replace '^ADMIN_SECRET=', '').Trim().Trim('"').Trim("'")
    Write-Host ('ADMIN_SECRET length: ' + $val.Length)
} else {
    Write-Host 'ADMIN_SECRET: NOT FOUND'
}

# Worker API auth check (401=secret wrong, 200=OK, 403=forbidden)
$workerUrl = 'https://mal-search-system.navigator-187.workers.dev'
try {
    $r = Invoke-WebRequest -Uri ($workerUrl + '/api/admin/stats') -Headers @{Authorization='Bearer dummy-test'} -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
    Write-Host ('Worker admin/stats: HTTP ' + $r.StatusCode)
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Host ('Worker admin/stats (dummy auth): HTTP ' + $code + ' (401=auth working, 200=no auth required)')
}

# TERASS session via CDP tabs
try {
    $tabs = (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop).Content | ConvertFrom-Json
    $terass = $tabs | Where-Object { $_.url -match 'terass' }
    if ($terass) {
        Write-Host ('TERASS_TAB: FOUND - ' + $terass[0].url)
    } else {
        Write-Host 'TERASS_TAB: NOT FOUND'
        Write-Host 'Open tabs:'
        foreach ($tab in $tabs) { Write-Host ('  ' + $tab.url) }
    }
} catch {
    Write-Host ('CDP tabs: ERROR - ' + $_.Exception.Message)
}

# wrangler secret list (ADMIN_SECRET set in CF?)
Write-Host ''
Write-Host '--- Cloudflare Worker secrets ---'
$wdir = 'C:\Users\reale\Downloads\mal-worker'
& wrangler secret list --cwd $wdir 2>&1 | ForEach-Object { Write-Host $_ }
