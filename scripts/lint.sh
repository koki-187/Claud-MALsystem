#!/usr/bin/env bash
# MAL検索システム リントチェック
# Usage: ./scripts/lint.sh

set -e

echo "🔎 リントチェック"
echo "================================================"

WARN=0

# TSC
echo ""
echo "[1/3] TypeScript チェック"
if [ -f "node_modules/.bin/tsc" ]; then
  if npx tsc --noEmit; then
    echo "  ✅ TypeScript型エラーなし"
  else
    echo "  ❌ TypeScript型エラー"
    exit 1
  fi
else
  echo "  ⚠️  npm install が必要"
  WARN=1
fi

# 禁止パターン検出
echo ""
echo "[2/3] 禁止パターン検出"
if grep -rEn 'console\.log|debugger' src/ 2>/dev/null | grep -v '// allow-log'; then
  echo "  ⚠️  console.log / debugger が残っています（許容する場合は // allow-log を付ける）"
  WARN=1
else
  echo "  ✅ console.log / debugger なし"
fi

# シークレット混入検出
echo ""
echo "[3/3] シークレット混入チェック"
if grep -rEn 'sk_(live|test)_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}' src/ 2>/dev/null; then
  echo "  ❌ シークレットらしき文字列を検出 — コミット前に削除してください"
  exit 1
else
  echo "  ✅ シークレット検出なし"
fi

echo ""
echo "================================================"
if [ "$WARN" = "1" ]; then
  echo "⚠️  警告ありで完了"
else
  echo "✅ リントOK"
fi
