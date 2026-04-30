@echo off
chcp 65001 >nul
cd /d C:\Users\reale\Downloads\mal-worker

echo ============================================
echo  MAL 全スクレイパー一括実行
echo  目標: 100万件達成
echo ============================================
echo.

echo [1/5] 健美家 全47都道府県...
node scripts\scrape-kenbiya-full-local.mjs
echo.

echo [2/5] 楽待 全47都道府県...
node scripts\scrape-rakumachi-full-local.mjs
echo.

echo [3/5] CHINTAI 全47都道府県...
node scripts\scrape-chintai-full-local.mjs
echo.

echo [4/5] homes.co.jp 全カテゴリ全47都道府県...
node scripts\scrape-homes-all-local.mjs
echo.

echo [5/5] SUUMO 全国 賃貸+売買...
node scripts\scrape-suumo-local.mjs
echo.

echo ============================================
echo  全スクレイパー完了！
echo ============================================
pause
