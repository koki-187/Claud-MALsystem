#!/bin/bash
# =============================================================================
# TERASS 週次バックフィル — 日次対象外の 17 県 + 全県再確認
# 毎週日曜 03:00 に Task Scheduler から実行 (別途登録が必要)
# =============================================================================
# 日次で処理されない低ボリューム県 (北海道/東北/北陸/四国/沖縄 等)
WEEKLY_PREFS="hokkaido,aomori,iwate,akita,yamagata,fukushima,toyama,ishikawa,fukui,yamanashi,tottori,shimane,tokushima,kagawa,kochi,nagasaki,okinawa"

PROJECT_DIR="C:/Users/reale/Downloads/mal-worker"
LOG_FILE="$PROJECT_DIR/.weekly-backfill.log"
PROGRESS_FILE="$PROJECT_DIR/.weekly-progress"

cd "$PROJECT_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

log "=========================================="
log "週次バックフィル 開始"
log "対象: $WEEKLY_PREFS"
log "=========================================="

touch "$PROGRESS_FILE"

SUCCESS=0
FAILED=0

IFS=',' read -ra PREFS <<< "$WEEKLY_PREFS"
for pref in "${PREFS[@]}"; do
  if grep -qx "$pref" "$PROGRESS_FILE" 2>/dev/null; then
    log "  skip $pref (今週完了済み)"
    continue
  fi

  log "▶ $pref 開始"
  START=$(date +%s)

  if timeout 1200 node scripts/extract-terass.mjs --prefectures="$pref" >> "$LOG_FILE" 2>&1; then
    ELAPSED=$(($(date +%s) - START))
    log "  ✓ $pref 完了 (${ELAPSED}s)"
    echo "$pref" >> "$PROGRESS_FILE"
    SUCCESS=$((SUCCESS + 1))
  else
    log "  ✗ $pref 失敗"
    FAILED=$((FAILED + 1))
  fi

  sleep 20
done

# 毎週月曜は progress をリセット (7日サイクル)
if [ "$(date +%u)" = "1" ]; then
  > "$PROGRESS_FILE"
  log "週次 progress リセット (月曜)"
fi

log "=========================================="
log "週次バックフィル完了: 成功 $SUCCESS / 失敗 $FAILED"
log "=========================================="
