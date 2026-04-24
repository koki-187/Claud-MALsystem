# Check encoding of .env file
$envPath = 'C:\Users\reale\Downloads\mal-worker\.env'
$bytes = [System.IO.File]::ReadAllBytes($envPath)
Write-Host "Total bytes: $($bytes.Length)"
Write-Host "First 10 bytes (hex): $(($bytes[0..([Math]::Min(9,$bytes.Length-1))] | ForEach-Object { $_.ToString('X2') }) -join ' ')"
Write-Host "Last 5 bytes (hex): $(($bytes[([Math]::Max(0,$bytes.Length-5))..($bytes.Length-1)] | ForEach-Object { $_.ToString('X2') }) -join ' ')"

# Check for BOM
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Write-Host "Encoding: UTF-8 WITH BOM (this causes PowerShell Get-Content issues!)"
    # Rewrite without BOM
    $content = [System.IO.File]::ReadAllText($envPath, [System.Text.Encoding]::UTF8)
    $noMomBytes = [System.Text.Encoding]::UTF8.GetBytes($content)
    [System.IO.File]::WriteAllBytes($envPath, $noMomBytes)
    Write-Host "Fixed: Rewritten without BOM"
} elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    Write-Host "Encoding: UTF-16 LE (BOM FF FE) - converting to UTF-8..."
    $content = [System.IO.File]::ReadAllText($envPath, [System.Text.Encoding]::Unicode)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($envPath, $content, $utf8NoBom)
    Write-Host "Fixed: Converted to UTF-8 without BOM"
} else {
    Write-Host "Encoding: UTF-8 (no BOM) or ASCII - should be fine"
}

# Verify fix
Write-Host ""
Write-Host "=== After fix ==="
$lines2 = Get-Content $envPath
Write-Host "Line count: $($lines2.Count)"
$sec2 = $lines2 | Where-Object { $_ -match '^ADMIN_SECRET=' }
if ($sec2) {
    $val2 = ($sec2[0] -replace '^ADMIN_SECRET=', '').Trim()
    Write-Host "ADMIN_SECRET length: $($val2.Length)"
}
