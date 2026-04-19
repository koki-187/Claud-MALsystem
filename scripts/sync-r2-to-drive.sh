#!/usr/bin/env bash
# R2 archive/ → Google Drive 3TB folder へバックアップ同期
# 前提: rclone (https://rclone.org) 導入済み + リモート名 'gdrive' 設定済み
# 設定方法: rclone config → n → name=gdrive → drive → root_folder_id=1o7duhNw1ngzT_EynWdX53cqzP-I_JHOB

set -euo pipefail

DRIVE_FOLDER_ID="1o7duhNw1ngzT_EynWdX53cqzP-I_JHOB"
LOCAL_BUF="/tmp/mal-r2-sync"
mkdir -p "$LOCAL_BUF"

echo "[sync] R2 → local download (archive/)..."
npx wrangler r2 object list real-estate-files --prefix=archive/ --json \
  | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const o=JSON.parse(d);
  for(const i of (o.objects||o)){console.log(i.key);}
});" > "$LOCAL_BUF/keys.txt"

while read -r key; do
  [ -z "$key" ] && continue
  out="$LOCAL_BUF/${key//\//_}"
  npx wrangler r2 object get "real-estate-files/$key" --file="$out" || true
done < "$LOCAL_BUF/keys.txt"

echo "[sync] rclone → Google Drive..."
rclone copy "$LOCAL_BUF" "gdrive:" --drive-root-folder-id="$DRIVE_FOLDER_ID" --progress

echo "[sync] 完了: $(date)"
