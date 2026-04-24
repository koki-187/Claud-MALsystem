Set-Location 'C:\Users\reale\Downloads\mal-worker'
Write-Host "=== TypeScript check ===" -ForegroundColor Cyan
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { Write-Host "TS ERROR - abort" -ForegroundColor Red; exit 1 }
Write-Host "TS OK" -ForegroundColor Green

Write-Host "=== wrangler deploy ===" -ForegroundColor Cyan
wrangler deploy
Write-Host "Exit: $LASTEXITCODE"
