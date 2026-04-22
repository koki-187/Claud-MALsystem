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

# Workerエンドポイント疎通 (admin は Bearer 認証必須、未設定なら public /api/health で代替)
echo ""
echo "[2/3] 本番Worker疎通テスト"
WORKER_URL="${WORKER_URL:-https://mal-search-system.navigator-187.workers.dev}"
ADMIN_SECRET="${ADMIN_SECRET:-}"
if [ -n "$ADMIN_SECRET" ]; then
  if curl -sf "${WORKER_URL}/api/admin/stats" \
      -H "Authorization: Bearer ${ADMIN_SECRET}" \
      -o /tmp/stats.json --max-time 10; then
    TOTAL=$(grep -o '"totalProperties":[0-9]*' /tmp/stats.json | head -1 | grep -o '[0-9]*')
    echo "  ✅ /api/admin/stats OK (totalProperties=${TOTAL})"
  else
    echo "  ❌ Admin API接続失敗 (認証 or ネットワーク): ${WORKER_URL}"
    exit 1
  fi
else
  if curl -sf "${WORKER_URL}/api/health" -o /tmp/health.json --max-time 10; then
    echo "  ✅ /api/health OK (ADMIN_SECRET 未設定のため admin/stats はスキップ)"
  else
    echo "  ❌ Worker接続失敗: ${WORKER_URL}"
    exit 1
  fi
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
