@echo off
chcp 65001 >nul
cd /d C:\Users\reale\Downloads\mal-worker

echo === ドライランテスト (インポートなし) ===
echo.

echo [1] 健美家 東京のみ dry-run...
node scripts\scrape-kenbiya-full-local.mjs --pref=13 --max-pages=2 --dry-run

echo [2] 楽待 東京のみ dry-run...
node scripts\scrape-rakumachi-full-local.mjs --pref=13 --max-pages=2 --dry-run

echo [3] CHINTAI 東京のみ dry-run...
node scripts\scrape-chintai-full-local.mjs --pref=13 --max-pages=2 --dry-run

echo [4] homes全カテゴリ 東京のみ dry-run...
node scripts\scrape-homes-all-local.mjs --pref=13 --max-pages=2 --dry-run

echo [5] SUUMO 東京のみ dry-run...
node scripts\scrape-suumo-local.mjs --pref=13 --max-pages=2 --dry-run

echo.
echo === 全ドライランテスト完了 ===
pause
