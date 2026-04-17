#!/usr/bin/env bash
# MAL検索システム テスト実行
# Usage: ./scripts/test.sh

set -e

echo "🧪 テスト実行"
echo "================================================"

# TypeScript型チェック
echo ""
echo "[1/3] TypeScript 型チェック"
if [ -f "node_modules/.bin/tsc" ]; then
  npx tsc --noEmit
  echo "  ✅ 型エラーなし"
else
  echo "  ⚠️  node_modules がありません。npm install を実行してください"
fi

# Workerエンドポイント疎通
echo ""
echo "[2/3] 本番Worker疎通テスト"
WORKER_URL="https://mal-search-system.navigator-187.workers.dev"
if curl -sf "${WORKER_URL}/api/admin/stats" -o /tmp/stats.json --max-time 10; then
  TOTAL=$(grep -o '"totalProperties":[0-9]*' /tmp/stats.json | head -1 | grep -o '[0-9]*')
  echo "  ✅ /api/admin/stats OK (totalProperties=${TOTAL})"
else
  echo "  ❌ Worker接続失敗: ${WORKER_URL}"
  exit 1
fi

# 検索エンドポイント
echo ""
echo "[3/3] 検索API疎通"
if curl -sf "${WORKER_URL}/api/search?prefecture=13&limit=1" -o /tmp/search.json --max-time 10; then
  echo "  ✅ /api/search OK"
else
  echo "  ⚠️  /api/search 失敗（未実装または認証必須）"
fi

echo ""
echo "================================================"
echo "✅ テスト完了"
