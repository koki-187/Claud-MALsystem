#!/bin/bash
# =============================================================================
# TERASS 46 県バックフィル (東京以外) — 再開可能 + 進捗ログ
# =============================================================================
# 使い方:
#   ./scripts/run-backfill-46.sh               # 通常実行
#   ./scripts/run-backfill-46.sh --resume      # 前回途中だった県から再開
#
# 進捗は C:/Users/reale/Downloads/mal-worker/.backfill-progress に保存。
# 各県終了ごとに「完了済み県リスト」を追記し、再開時は未完了のみ実行。
# =============================================================================

set -uo pipefail  # -e は外す: 1 県失敗しても次に進む

PROJECT_DIR="C:/Users/reale/Downloads/mal-worker"
PROGRESS_FILE="$PROJECT_DIR/.backfill-progress"
LOG_FILE="$PROJECT_DIR/.backfill.log"
cd "$PROJECT_DIR"

# 46 県 (東京は B テスト済のため除外)
PREFS_ALL=(hokkaido aomori iwate miyagi akita yamagata fukushima ibaraki tochigi gunma \
           saitama chiba kanagawa niigata toyama ishikawa fukui yamanashi nagano \
           gifu shizuoka aichi mie shiga kyoto osaka hyogo nara wakayama tottori \
           shimane okayama hiroshima yamaguchi tokushima kagawa ehime kochi fukuoka \
           saga nagasaki kumamoto oita miyazaki kagoshima okinawa)

touch "$PROGRESS_FILE"

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

log "=============================================="
log "TERASS 46 県バックフィル 開始"
log "=============================================="
log "対象: ${#PREFS_ALL[@]} 県"
log "完了済み: $(wc -l < "$PROGRESS_FILE") 県"

SUCCESS=0
FAILED=0

for pref in "${PREFS_ALL[@]}"; do
  if grep -qx "$pref" "$PROGRESS_FILE" 2>/dev/null; then
    log "  skip $pref (完了済み)"
    continue
  fi

  log "▶ $pref 開始"
  START=$(date +%s)

  # 1 県 = 6 カテゴリ = 約 8 分想定。タイムアウトは 20 分で安全側
  if timeout 1200 node scripts/extract-terass.mjs --prefectures="$pref" >> "$LOG_FILE" 2>&1; then
    ELAPSED=$(($(date +%s) - START))
    log "  ✓ $pref 完了 (${ELAPSED}s)"
    echo "$pref" >> "$PROGRESS_FILE"
    SUCCESS=$((SUCCESS + 1))
  else
    log "  ✗ $pref 失敗 (timeout or error)"
    FAILED=$((FAILED + 1))
  fi

  # レート制御: 県間に 30 秒休憩
  sleep 30
done

log "=============================================="
log "バックフィル完了: 成功 $SUCCESS / 失敗 $FAILED"
log "=============================================="
