# MAL検索システム v6.2

## プロジェクト概要
不動産物件検索システム。Hono + Cloudflare Workers + D1 + KV + R2 構成。
47都道府県×9サイト対応。TERASS PICKSデータ619,063件インポート済み。

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
  index.tsx          # エントリーポイント (Hono app + フロントエンドHTML)
  types/index.ts     # TypeScript型定義・定数
  db/queries.ts      # D1データベースクエリ関数
  routes/
    admin.ts         # 管理API (/api/admin/*)
  scrapers/
    base.ts          # ベーススクレイパークラス
    aggregator.ts    # 全サイト並列スクレイピング
    suumo.ts         # SUUMO
    homes.ts         # HOME'S
    athome.ts        # AtHome
    fudosan.ts       # 不動産Japan
    chintai.ts       # CHINTAI
    smaity.ts        # Smaity
    reins.ts         # REINS
    kenbiya.ts       # 健美家
    rakumachi.ts     # 楽待
migrations/
  0001_initial.sql
  0002_status_sites.sql
  0003_mysoku_seiyaku.sql
  0004_fingerprint_queue.sql
  seed.sql
scripts/               # リモート開発用スクリプト
  health-check.sh      # 環境ヘルスチェック
  auto-push.sh         # コミット後自動プッシュ
  test.sh / lint.sh
wrangler.toml          # Cloudflare設定 (実リソースID設定済み)
```

## 重要な注意事項
- `wrangler.toml` のリソースIDは本番環境の実IDです。変更しないでください。
- D1の `properties` テーブルは `detail_url TEXT NOT NULL` — INSERT時にNULLを渡すと `INSERT OR IGNORE` で無視されます。空文字 `''` を使用してください。
- `UNIQUE(site_id, site_property_id)` 制約があります。

## コマンド

### ビルド＆テスト（リモート環境）
```bash
./scripts/health-check.sh   # 環境ヘルスチェック
./scripts/test.sh            # テスト実行
./scripts/lint.sh            # リントチェック
```

### Windows タスクスケジューラ
```powershell
./scripts/register-terass-cron.ps1   # 日次 02:00 自動インポート登録
```

### デプロイ（デスクトップ環境のみ）
```bash
# Google Driveパスではnpm installが失敗するため、ローカルコピーを使用
cp -r . C:/Users/reale/Downloads/mal-worker/
cd C:/Users/reale/Downloads/mal-worker/
npm install
wrangler deploy
```

## リモート開発環境
- **Browser**: Claude Code Web (claude.ai/code)
- **iOS**: Claude iOS App → Claude Code
- **自動プッシュ**: PostToolUse フックで `git commit` 後に自動 `git push`
- **セッション開始フック**: `health-check.sh` で環境を自動検証

---

## セッション間同期プロトコル（必読）

### セッション開始時に必ず実行すること
**Desktop / Web / iOS すべてのセッションで、作業開始前に以下を実行：**

1. `git fetch origin` で全ブランチの最新状態を取得
2. `BUILD_LOG.md` を確認し、他のセッションの最新の構築状況を把握
3. 自分のブランチに他環境の変更がある場合は `git pull` でマージ
4. 他のブランチに未マージの変更がないか `git log` で確認

### 作業完了時に必ず実行すること
1. `BUILD_LOG.md` に今回の作業内容を追記（日時・環境・内容）
2. `git add . && git commit && git push` で変更をプッシュ
3. 大きな変更の場合、コミットメッセージに変更の要約を詳細に記載

### BUILD_LOG.md の書式
```markdown
## YYYY-MM-DD HH:MM (環境名)
- **環境**: Desktop / Web / iOS
- **ブランチ**: master / remote/xxx / claude/xxx
- **変更内容**: 変更の概要
- **デプロイ**: 済 / 未 / 不要
- **次のタスク**: 次に必要な作業（あれば）
```

### 構築状況の確認方法
どのセッションからでも以下で最新状況を確認可能：
```bash
# 全ブランチの最新コミットを確認
git fetch origin && git branch -a -v

# BUILD_LOG.md で他セッションの作業内容を確認
cat BUILD_LOG.md

# masterとの差分を確認
git log origin/master..HEAD --oneline
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
