#!/usr/bin/env bash
# TERASS PICKS 自動インポートトリガー (Phase 1 スケルトン)
#
# 役割: TERASS PICKS から取得した CSV を D1 にインポートする
# 想定実行環境: デスクトップの Windows Task Scheduler / cron で日次実行
#
# 前提条件:
#   1. Chrome IndexedDB → CSV 抽出は別途 Playwright/拡張で実行済 (本スクリプトの対象外)
#   2. 抽出した CSV は CSV_DIR 配下に MAL_*.csv で配置されている
#   3. d1_bulk_import_v2.mjs を node で実行できる
#
# 使い方:
#   ./scripts/auto-import-terass.sh
#
# Cron設定例 (Windows Task Scheduler):
#   毎日 3:00 に bash.exe -c "/path/to/scripts/auto-import-terass.sh"

set -e

CSV_DIR="${TERASS_CSV_DIR:-C:/Users/reale/Downloads/TERASS_MAL_converted}"
IMPORT_SCRIPT="${IMPORT_SCRIPT:-C:/Users/reale/Downloads/d1_bulk_import_v2.mjs}"
LOG_DIR="${LOG_DIR:-C:/Users/reale/Downloads}"
LOG_FILE="${LOG_DIR}/terass_auto_import_$(date +%Y%m%d_%H%M%S).log"

echo "🌅 TERASS自動インポート開始: $(date)"
echo "   CSV_DIR=$CSV_DIR"
echo "   LOG=$LOG_FILE"

# 1. CSVが存在するか確認
csv_count=$(ls "$CSV_DIR"/MAL_ALL_*.csv 2>/dev/null | wc -l)
if [ "$csv_count" -eq 0 ]; then
  echo "❌ CSVファイルなし: $CSV_DIR/MAL_ALL_*.csv"
  echo "   先にTERASS PICKSからエクスポート → $CSV_DIR に配置してください"
  exit 1
fi
echo "✅ ${csv_count}件のCSV発見"

# 2. インポート実行 (バックグラウンド可)
node "$IMPORT_SCRIPT" 2>&1 | tee "$LOG_FILE"

# 3. 完了ヘルスチェック
echo ""
echo "📊 D1統計を取得..."
curl -sf "https://mal-search-system.navigator-187.workers.dev/api/admin/stats" \
  --max-time 10 \
  -o /tmp/stats.json && {
  total=$(grep -o '"totalProperties":[0-9]*' /tmp/stats.json | grep -o '[0-9]*')
  echo "✅ 完了: D1 total = $total properties"
}

echo "🌇 終了: $(date)"
