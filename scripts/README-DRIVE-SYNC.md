# R2 → Google Drive 同期スクリプト

## 概要
`sync-r2-to-drive.sh` は Cloudflare R2 の `archive/` プレフィックス配下の JSONL アーカイブを
Google Drive 3TB 保管庫 (`1o7duhNw1ngzT_EynWdX53cqzP-I_JHOB`) へ同期します。

## 前提条件

1. **rclone** インストール済み: https://rclone.org/downloads/
2. **wrangler** が `npx wrangler` で実行可能
3. rclone に `gdrive` リモートが設定済み (下記手順参照)

## rclone 初期設定

```bash
rclone config
# → n (新規リモート)
# → name: gdrive
# → Storage: Google Drive (選択)
# → client_id: (空白でEnter)
# → client_secret: (空白でEnter)
# → scope: 1 (full access)
# → root_folder_id: 1o7duhNw1ngzT_EynWdX53cqzP-I_JHOB
# → ブラウザ認証を完了
```

## 実行方法

```bash
# 手動実行
bash scripts/sync-r2-to-drive.sh

# Windows 上で Git Bash 使用時
"C:\Program Files\Git\bin\bash.exe" scripts/sync-r2-to-drive.sh
```

## Windows Task Scheduler 設定例

1. タスクスケジューラを開く
2. 「タスクの作成」→ 全般タブ: 名前 `MAL R2→Drive Sync`
3. トリガー: 毎週月曜 02:00 (JST)
4. 操作: プログラム = `C:\Program Files\Git\bin\bash.exe`
   引数 = `"H:\マイドライブ\... (プロジェクトパス)\scripts\sync-r2-to-drive.sh"`

## 注意事項
- `archive-cold` エンドポイントで D1 から削除した行だけが R2 に存在します
- アーカイブキー形式: `archive/properties/YYYY-MM-DD_<timestamp>.jsonl`
- 復元時は JSONL を D1 に再インポートしてください
