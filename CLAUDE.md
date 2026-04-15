# MAL検索システム v6.2

## プロジェクト概要
不動産物件検索システム。Hono + Cloudflare Workers + D1 + KV + R2 構成。
47都道府県×7サイト対応。TERASS PICKSデータ619,063件インポート済み。

## 技術スタック
- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite互換)
- **Cache**: Cloudflare KV (`mal-search-cache`)
- **Storage**: Cloudflare R2 (`real-estate-files`)
- **Language**: TypeScript

## リソースID
- **D1 DB**: `2a731ee6-d1c7-4f51-8bcc-f15f993ad870` (mal-search-db)
- **KV**: `91469fbf31a04241a54e0acdcb7b14c2` (mal-search-cache)
- **Worker URL**: `https://mal-search-system.navigator-187.workers.dev`
- **GitHub**: `koki-187/Claud-MALsystem` (master branch)

## ディレクトリ構造
```
src/
  index.tsx      # エントリーポイント (Hono app)
  routes/
    admin.ts     # 管理API (/api/admin/*)
    search.ts    # 検索API
migrations/
  0001_initial.sql
  0002_status_sites.sql
  0003_mysoku_seiyaku.sql
  0004_fingerprint_queue.sql
wrangler.toml    # Cloudflare設定 (実リソースID設定済み)
```

## 重要な注意事項
- `wrangler.toml` のリソースIDは本番環境の実IDです。変更しないでください。
- D1の `properties` テーブルは `detail_url TEXT NOT NULL` — INSERT時にNULLを渡すと `INSERT OR IGNORE` で無視されます。空文字 `''` を使用してください。
- `UNIQUE(site_id, site_property_id)` 制約があります。

## デプロイ
```bash
# Google Driveパスではnpm installが失敗するため、ローカルコピーを使用
cp -r . C:/Users/reale/Downloads/mal-worker/
cd C:/Users/reale/Downloads/mal-worker/
npm install
wrangler deploy
```

---

## リモート開発ルール (Desktop / Web / iOS共通)

### 基本原則
1. **作業開始時**: 必ず `git pull origin master` で最新コードを取得
2. **作業完了時**: 必ず `git add . && git commit && git push origin master` で変更をプッシュ
3. **コンフリクト防止**: 同一ファイルをデスクトップとリモートで同時編集しない

### 環境別の制約
| 操作 | Desktop (Claude Code) | Web/iOS (Claude Code Remote) |
|------|----------------------|------------------------------|
| コード編集 | OK | OK |
| git push/pull | OK | OK |
| wrangler deploy | OK | NG (CLIなし) |
| D1マイグレーション | OK | NG |
| npm install | OK | 要確認 |

### ブランチ戦略
- **master**: 本番デプロイ用。安定コードのみ。
- **remote/***: リモート版での作業用ブランチ (例: `remote/feature-xxx`)
- リモート版での大きな変更は `remote/` ブランチで作業し、デスクトップ版でmasterにマージ＆デプロイ

### デプロイフロー
```
[リモート版] コード変更 → git push (remote/ブランチ)
    ↓
[デスクトップ版] git pull → レビュー → master にマージ → wrangler deploy
```

### 禁止事項
- リモート版から `wrangler.toml` のリソースIDを変更しない
- `.env` や認証情報をコミットしない
- `node_modules/` をコミットしない
- masterブランチへの force push 禁止
