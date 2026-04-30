@echo off
cd /d "C:\Users\reale\Downloads\mal-worker"
echo === TypeScript check ===
call npx tsc --noEmit
if errorlevel 1 (
  echo TS ERROR - aborting deploy
  pause
  exit /b 1
)
echo TS OK
echo === wrangler deploy ===
call npx wrangler deploy
echo.
echo === Deploy Exit Code: %errorlevel% ===
pause
