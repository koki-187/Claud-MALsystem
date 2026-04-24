$lines = Get-Content 'C:\Users\reale\Downloads\mal-worker\.env'
$sec = $lines | Where-Object { $_ -match '^ADMIN_SECRET=' }
if ($sec) {
    $val = ($sec[0] -replace '^ADMIN_SECRET=', '').Trim().Trim('"').Trim("'")
    Write-Host ('ADMIN_SECRET value length: ' + $val.Length)
    if ($val.Length -ge 4) {
        Write-Host ('First 4 chars: ' + $val.Substring(0, 4) + '...')
    } else {
        Write-Host ('Full value: [' + $val + ']')
    }
} else {
    Write-Host 'ADMIN_SECRET: NOT FOUND in .env'
}
