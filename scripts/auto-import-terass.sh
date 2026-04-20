#!/usr/bin/env bash
# TERASS PICKS 自動インポートトリガー (Phase 1)
#
# 役割:
#   1. Chrome CDP 経由で TERASS PICKS IndexedDB → CSV を自動抽出
#   2. 変換スクリプトで D1 にインポート
#
# 想定実行環境: デスクトップの Windows Task Scheduler / cron で日次実行
#
# =====================================================================
# 【事前準備】Chrome を CDP モードで起動する方法
#
#   "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
#     --remote-debugging-port=9222 ^
#     --user-data-dir="%APPDATA%\Chrome_CDP"
#
#   起動後、https://picks-agent.terass.com/search/mansion (または旧 picks.terass-agents.com) を開いてログインしておく
#   (初回のみ。以降は同じ --user-data-dir を使えばセッションが維持される)
# =====================================================================
#
# 環境変数で動作をカスタマイズ可能:
#   SKIP_EXTRACT=1      ... CSVの自動抽出をスキップ (既存CSVを使用)
#   CDP_URL             ... Chrome CDPのURL (デフォルト: http://localhost:9222)
#   DOWNLOADS_DIR       ... ダウンロード先 (デフォルト: C:/Users/reale/Downloads)
#   TERASS_CSV_DIR      ... 変換済CSVのディレクトリ
#   IMPORT_SCRIPT       ... 変換&インポートスクリプトのパス
#
# 使い方:
#   ./scripts/auto-import-terass.sh              # 通常実行 (抽出 + インポート)
#   SKIP_EXTRACT=1 ./scripts/auto-import-terass.sh  # インポートのみ (fallback)
#
# Cron設定例 (Windows Task Scheduler):
#   毎日 3:00 に bash.exe -c "cd /d/マイドライブ/... && ./scripts/auto-import-terass.sh"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

CSV_DIR="${TERASS_CSV_DIR:-C:/Users/reale/Downloads/TERASS_MAL_converted}"
IMPORT_SCRIPT="${IMPORT_SCRIPT:-C:/Users/reale/Downloads/d1_bulk_import_v2.mjs}"
EXTRACT_SCRIPT="${PROJECT_DIR}/scripts/extract-terass.mjs"
LOG_DIR="${LOG_DIR:-C:/Users/reale/Downloads}"
LOG_FILE="${LOG_DIR}/terass_auto_import_$(date +%Y%m%d_%H%M%S).log"
SKIP_EXTRACT="${SKIP_EXTRACT:-0}"

echo "[auto-import] =========================================="
echo "[auto-import] TERASS自動インポート開始: $(date)"
echo "[auto-import] CSV_DIR=$CSV_DIR"
echo "[auto-import] LOG=$LOG_FILE"
echo "[auto-import] =========================================="

# =====================================================================
# Step 1: TERASS PICKS → CSV 自動抽出 (extract-terass.mjs)
# =====================================================================
extract_ok=0

if [ "$SKIP_EXTRACT" = "1" ]; then
  echo "[auto-import] SKIP_EXTRACT=1 のため抽出をスキップ"
  extract_ok=0  # fallback パスへ
else
  if [ ! -f "$EXTRACT_SCRIPT" ]; then
    echo "[auto-import] WARNING: 抽出スクリプトが見つかりません: $EXTRACT_SCRIPT"
    echo "[auto-import]   既存CSVでのインポートに切り替えます"
  else
    echo "[auto-import] Chrome IndexedDB → CSV 抽出中..."
    echo "[auto-import] スクリプト: $EXTRACT_SCRIPT"

    node "$EXTRACT_SCRIPT" 2>&1 | tee -a "$LOG_FILE"
    # PIPESTATUS[0] は node の真の終了コード (tee の終了コードではない)
    extract_code=${PIPESTATUS[0]}
    if [ "$extract_code" -eq 0 ]; then
      echo "[auto-import] CSV抽出完了"
      extract_ok=1
    else
      echo "[auto-import] WARNING: 抽出スクリプトがコード ${extract_code} で失敗しました"
      echo "[auto-import]   既存CSVでのインポートに切り替えます (fallback)"
      extract_ok=0
    fi
  fi
fi

# =====================================================================
# Step 2: インポート実行
#   - 抽出成功時: extract-terass.mjs が既に変換&インポートを実行済み
#   - 抽出失敗時 (fallback): 既存 CSV から直接インポート
# =====================================================================

if [ "$extract_ok" = "0" ]; then
  # fallback: 既存CSVを使ってインポート
  echo "[auto-import] --- fallback: 既存CSVからインポート ---"

  csv_count=$(ls "$CSV_DIR"/MAL_ALL_*.csv 2>/dev/null | wc -l || echo 0)
  if [ "$csv_count" -eq 0 ]; then
    echo "[auto-import] ERROR: CSVファイルなし: $CSV_DIR/MAL_ALL_*.csv"
    echo "[auto-import]   TERASS PICKSからエクスポート後に再実行してください"
    exit 1
  fi
  echo "[auto-import] ${csv_count}件のCSV発見"

  if [ ! -f "$IMPORT_SCRIPT" ]; then
    echo "[auto-import] ERROR: インポートスクリプトが見つかりません: $IMPORT_SCRIPT"
    exit 1
  fi

  echo "[auto-import] インポート実行: $IMPORT_SCRIPT"
  node "$IMPORT_SCRIPT" 2>&1 | tee -a "$LOG_FILE"
fi

# =====================================================================
# Step 3: 完了ヘルスチェック
# =====================================================================
echo ""
echo "[auto-import] D1統計を取得中..."
if curl -sf "https://mal-search-system.navigator-187.workers.dev/api/admin/stats" \
    --max-time 10 \
    -o /tmp/mal_stats.json 2>/dev/null; then
  total=$(grep -o '"totalProperties":[0-9]*' /tmp/mal_stats.json | grep -o '[0-9]*' || echo '不明')
  echo "[auto-import] 完了: D1 total = ${total} properties"
else
  echo "[auto-import] WARNING: ヘルスチェックに失敗しました (ネットワーク確認)"
fi

echo "[auto-import] =========================================="
echo "[auto-import] 終了: $(date)"
echo "[auto-import] =========================================="
