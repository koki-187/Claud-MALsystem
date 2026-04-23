#!/usr/bin/env bash
# initial-cleanup.sh — 初回大掃除スクリプト
# D1 が逼迫している場合に archive-cold?age_days=30 を繰り返し実行して容量を削減する。
# 目標: 484MB → 300MB 以下 (最大 20 回)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# ── 設定読み込み ──────────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

WORKER_URL="${WORKER_URL:-https://mal-search-system.navigator-187.workers.dev}"
ADMIN_SECRET="${ADMIN_SECRET:-}"
TARGET_MB="${TARGET_MB:-300}"
MAX_ROUNDS="${MAX_ROUNDS:-20}"

if [ -z "$ADMIN_SECRET" ]; then
  echo "[ERROR] ADMIN_SECRET is not set. Set it in .env or as an environment variable."
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $ADMIN_SECRET"

# ── 現在の D1 サイズを取得 (MB) ───────────────────────────────────────────────
get_d1_mb() {
  local stats
  stats=$(curl -s -H "$AUTH_HEADER" "$WORKER_URL/api/admin/stats") || { echo "0"; return; }
  # stats JSON には d1_size_mb フィールドがある想定
  local mb
  mb=$(echo "$stats" | grep -o '"d1_size_mb":[0-9.]*' | head -1 | cut -d: -f2)
  echo "${mb:-0}"
}

# ── メインループ ──────────────────────────────────────────────────────────────
echo "[initial-cleanup] Start. target=${TARGET_MB}MB, max_rounds=${MAX_ROUNDS}"

round=0
while [ "$round" -lt "$MAX_ROUNDS" ]; do
  current_mb=$(get_d1_mb)
  echo "[initial-cleanup] Round $((round + 1))/${MAX_ROUNDS}: D1 size = ${current_mb}MB"

  # 目標達成チェック (整数比較)
  current_int="${current_mb%%.*}"
  if [ -n "$current_int" ] && [ "$current_int" -le "$TARGET_MB" ] 2>/dev/null; then
    echo "[initial-cleanup] Target reached (${current_mb}MB <= ${TARGET_MB}MB). Done."
    exit 0
  fi

  # archive-cold?age_days=30&batches=5&batch_size=2000 を呼ぶ (1回で最大 10,000 行削減)
  echo "[initial-cleanup] Calling archive-cold (age_days=30, batches=5, batch_size=2000)..."
  result=$(curl -s -X POST \
    -H "$AUTH_HEADER" \
    "$WORKER_URL/api/admin/archive-cold?age_days=30&batches=5&batch_size=2000") || true
  echo "[initial-cleanup] Result: $result"

  # archived=0 なら対象行がなくなったので終了
  if echo "$result" | grep -q '"archived":0'; then
    echo "[initial-cleanup] No more rows to archive. Stopping."
    break
  fi

  round=$((round + 1))
  # 連続呼び出しで Worker を過負荷にしないよう少し待つ
  sleep 3
done

# 最終サイズ確認
final_mb=$(get_d1_mb)
echo "[initial-cleanup] Finished after $((round)) round(s). Final D1 size = ${final_mb}MB"

if [ -n "${final_mb%%.*}" ] && [ "${final_mb%%.*}" -le "$TARGET_MB" ] 2>/dev/null; then
  echo "[initial-cleanup] SUCCESS: ${final_mb}MB <= ${TARGET_MB}MB"
  exit 0
else
  echo "[initial-cleanup] WARNING: target not reached (${final_mb}MB > ${TARGET_MB}MB). Run again or increase MAX_ROUNDS."
  exit 1
fi
