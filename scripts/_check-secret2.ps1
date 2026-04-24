$envPath = 'C:\Users\reale\Downloads\mal-worker\.env'
Write-Host "File exists: $(Test-Path $envPath)"
Write-Host "File size: $((Get-Item $envPath).Length) bytes"

$raw = Get-Content $envPath -Raw
Write-Host "Raw length: $($raw.Length)"
Write-Host "Raw first 80 chars: $($raw.Substring(0, [Math]::Min(80, $raw.Length)))"

$lines = Get-Content $envPath
Write-Host "Line count: $($lines.Count)"
foreach ($i in 0..($lines.Count - 1)) {
    Write-Host "Line $i (len=$($lines[$i].Length)): $($lines[$i].Substring(0, [Math]::Min(50, $lines[$i].Length)))"
}

$sec = $lines | Where-Object { $_ -match '^ADMIN_SECRET=' }
Write-Host "Matching lines: $($sec.Count)"
if ($sec) {
    Write-Host "sec[0] length: $($sec[0].Length)"
    $val = ($sec[0] -replace '^ADMIN_SECRET=', '')
    Write-Host "val length after replace: $($val.Length)"
}
