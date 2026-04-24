@echo off
:: ================================================================
:: TERASS Task Scheduler 登録バッチ
:: 右クリック → "管理者として実行" で実行してください
:: ================================================================
chcp 65001 >nul

echo ================================================
echo  TERASS Task Scheduler 登録
echo ================================================
echo.

:: 日次タスク削除&再登録 (Interactive user)
schtasks /DELETE /TN "TERASS_AutoImport_Daily" /F >nul 2>&1

schtasks /CREATE /TN "TERASS_AutoImport_Daily" ^
  /TR "\"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe\" -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"C:\Users\reale\Downloads\mal-worker\scripts\run-auto-import.ps1\"" ^
  /SC DAILY /ST 02:00 ^
  /RU "%USERDOMAIN%\%USERNAME%" ^
  /RL HIGHEST /F

if %ERRORLEVEL% EQU 0 (
  echo [OK] 日次タスク登録完了: 毎日 02:00
) else (
  echo [ERROR] 日次タスク登録失敗 - 管理者として実行してください
)

echo.

:: 週次タスク削除&再登録
schtasks /DELETE /TN "TERASS-PICKS-Weekly-Backfill" /F >nul 2>&1

schtasks /CREATE /TN "TERASS-PICKS-Weekly-Backfill" ^
  /TR "\"C:\Program Files\Git\bin\bash.exe\" -lc \"cd /c/Users/reale/Downloads/mal-worker && bash scripts/run-weekly-backfill.sh\"" ^
  /SC WEEKLY /D SUN /ST 03:30 ^
  /RU "%USERDOMAIN%\%USERNAME%" ^
  /RL HIGHEST /F

if %ERRORLEVEL% EQU 0 (
  echo [OK] 週次タスク登録完了: 毎週日曜 03:30
) else (
  echo [ERROR] 週次タスク登録失敗
)

echo.
echo ================================================
echo  登録確認
echo ================================================
schtasks /Query /TN "TERASS_AutoImport_Daily" /FO LIST 2>&1 | findstr /i "タスク名\|状態\|スケジュール\|開始時刻\|ユーザー"
echo.
schtasks /Query /TN "TERASS-PICKS-Weekly-Backfill" /FO LIST 2>&1 | findstr /i "タスク名\|状態\|スケジュール\|開始時刻\|ユーザー"
echo.
echo 完了。このウィンドウを閉じてください。
pause
