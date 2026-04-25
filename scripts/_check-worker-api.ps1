$envLines = @(Get-Content 'C:\Users\reale\Downloads\mal-worker\.env')
$secLine = @($envLines | Where-Object { $_ -match '^ADMIN_SECRET=' })
$secret = ($secLine[0].ToString() -replace '^ADMIN_SECRET=', '').Trim()
Write-Host "Using secret (len=$($secret.Length)): $($secret.Substring(0,4))..."

$workerUrl = 'https://mal-search-system.navigator-187.workers.dev'
$headers = @{ Authorization = "Bearer $secret" }

try {
    $r = Invoke-WebRequest -Uri ($workerUrl + '/api/admin/stats') `
        -Headers $headers -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
    Write-Host "HTTP $($r.StatusCode)"
    $r.Content | ConvertFrom-Json | ConvertTo-Json -Depth 3
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    Write-Host "HTTP $code - $($_.Exception.Message)"
}
