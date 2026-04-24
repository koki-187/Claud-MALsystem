# Try different encodings
$envPath = 'C:\Users\reale\Downloads\mal-worker\.env'

Write-Host '--- Get-Content (default) ---'
$lines = Get-Content $envPath
Write-Host "Type: $($lines.GetType().FullName)"
Write-Host "Count: $($lines.Count)"
if ($lines -is [array]) {
    Write-Host "lines[0] type: $($lines[0].GetType().FullName), len: $($lines[0].ToString().Length)"
} else {
    Write-Host "lines type: $($lines.GetType().FullName), len: $($lines.ToString().Length)"
}

Write-Host ''
Write-Host '--- Get-Content -Encoding UTF8 ---'
$lines2 = Get-Content $envPath -Encoding UTF8
Write-Host "Type: $($lines2.GetType().FullName)"
if ($lines2 -is [array]) {
    Write-Host "Count: $($lines2.Count)"
    Write-Host "lines2[0] type: $($lines2[0].GetType().FullName), len: $($lines2[0].ToString().Length)"
    $sec = $lines2 | Where-Object { $_.ToString() -match '^ADMIN_SECRET=' }
    if ($sec) {
        $val = ($sec[0].ToString() -replace '^ADMIN_SECRET=', '').Trim()
        Write-Host "ADMIN_SECRET length: $($val.Length)"
    }
} else {
    Write-Host "lines2 type: $($lines2.GetType().FullName), len: $($lines2.ToString().Length)"
}

Write-Host ''
Write-Host '--- ReadAllText approach ---'
$raw = [System.IO.File]::ReadAllText($envPath, [System.Text.Encoding]::UTF8)
$line1 = ($raw -split '\r?\n')[0]
Write-Host "Line 1: [$line1]"
Write-Host "Line 1 length: $($line1.Length)"
$val3 = ($line1 -replace '^ADMIN_SECRET=', '').Trim()
Write-Host "ADMIN_SECRET value length: $($val3.Length)"
