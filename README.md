# 🌎 MAL検索システム v6.2
## My Agent Locator - 47都道府県・9サイト横断 不動産情報統合検索システム

---

## 概要

MAL（My Agent Locator）は、日本全国47都道府県の主要不動産9サイトを横断検索する
業者向け統合プラットフォームです。Cloudflare Workers + Hono v4 + TypeScript で構築され、
エッジで高速動作します。

TERASS PICKS の IndexedDB から日次自動エクスポートしたデータ (619,063 件 import 済) を
ベースに、master_properties テーブルで重複統合し、9 サイトのライブスクレイピングと
ハイブリッドに検索結果を返します。

### 対応サイト

| サイト | 種別 | 特徴 |
|--------|------|------|
| 🏠 SUUMO | 売買・賃貸 | 日本最大級の不動産情報サイト |
| 🏡 HOME'S | 売買・賃貸 | 豊富な物件データベース |
| 🏘 AtHome | 売買・賃貸 | 全国の不動産会社が掲載 |
| 🏗 不動産Japan | 売買 | 国土交通省系の信頼性高い情報 |
| 🏢 CHINTAI | 賃貸専門 | 賃貸物件に特化したサービス |
| 🏬 Smaity | 投資・売買 | 投資用物件に強み |
| 📋 REINS | 業者向け | 不動産流通機構レインズ登録物件 |
| 💰 健美家 | 収益物件 | 収益・投資物件に特化 |
| 📈 楽待 | 収益物件 | 投資不動産ポータル |

### データソース (一次データ)

| ソース | 取り込み方法 | 頻度 |
|--------|-------------|------|
| TERASS PICKS | IndexedDB → CSV → D1 import | 毎日 03:00 (Windows Task Scheduler + Cloudflare cron) |
| 9サイト ライブ | Worker からスクレイピング → D1 cache | 検索時 / 4h 定期 |

---

## 機能一覧

- **47都道府県横断検索** - 全国の物件を一度に検索
- **9サイト統合API** - 複数サイトの情報を並列取得・統合
- **マスター物件統合** (`/api/search/master`) - fingerprint で重複排除済みデータを返却
- **高度なフィルタリング** - 価格・面積・間取り・築年数・駅徒歩・利回りなど
- **TERASS PICKS 自動取り込み** - IndexedDB から CSV エクスポート → D1 import を 03:00 自動実行
- **画像パイプライン** - download_queue 経由で R2 に永続化
- **コールドアーカイブ** - status=sold/delisted を JSONL で R2 に退避
- **KVキャッシュ** - 検索結果を自動キャッシュ (TTL: 1時間)
- **レート制限** - サイトごとの API レート管理 + IP rate-limit
- **ダーク/ライトモード** - テーマ切替対応
- **PWA対応** - manifest.json
- **管理ダッシュボード** - サイト別・都道府県別の物件数統計、D1/R2 容量モニタリング

---

## 技術スタック

```
Framework:   Hono v4 + TypeScript
Runtime:     Cloudflare Workers
Database:    Cloudflare D1 (SQLite互換, 5GB free tier)
Cache:       Cloudflare KV (mal-search-cache)
Storage:     Cloudflare R2 (real-estate-files)
Frontend:    Vanilla JS + 自前 Design System CSS + Font Awesome
Cron:        Cloudflare Triggers (0 3/9/15/21 * * *, */15 * * * *)
Auto Import: Windows Task Scheduler + PowerShell + Playwright + Chrome CDP
```

### 本番リソース

| 種別 | ID / URL |
|------|----------|
| Worker URL | `https://mal-search-system.navigator-187.workers.dev` |
| D1 DB | `2a731ee6-d1c7-4f51-8bcc-f15f993ad870` (mal-search-db) |
| KV | `91469fbf31a04241a54e0acdcb7b14c2` (mal-search-cache) |
| R2 | `real-estate-files` |
| GitHub | `koki-187/Claud-MALsystem` (master) |

---

## セットアップ

### 前提条件
- Node.js 18+
- Cloudflare アカウント (Workers Paid 推奨)
- Wrangler CLI 3.x

### インストール

```bash
npm install
```

> **注意**: Google Drive 配下では `npm install` が失敗するため、
> `cp -r . C:/Users/reale/Downloads/mal-worker/ && cd C:/Users/reale/Downloads/mal-worker/`
> など Drive 外のパスにコピーしてから実行してください。

### 環境設定

`wrangler.toml` のリソース ID は本番環境の実 ID です。クローン時のみ更新が必要:

```bash
wrangler d1 create mal-search-db
wrangler kv:namespace create MAL_CACHE
wrangler r2 bucket create real-estate-files
```

### マイグレーション

```bash
wrangler d1 migrations apply mal-search-db --remote
```

### ローカル開発

```bash
npm run dev   # http://localhost:8788
```

### デプロイ

```bash
wrangler deploy
```

---

## プロジェクト構造

```
src/
  index.tsx              # エントリーポイント (Hono app + フロントエンドHTML 1900+ 行)
  types/index.ts         # TypeScript型定義・定数
  db/queries.ts          # D1データベースクエリ関数
  routes/
    admin.ts             # 管理API (/api/admin/*)
  scrapers/
    base.ts              # ベーススクレイパー
    aggregator.ts        # 全サイト並列スクレイピング
    suumo.ts / homes.ts / athome.ts / fudosan.ts /
    chintai.ts / smaity.ts / reins.ts /
    kenbiya.ts / rakumachi.ts
  services/
    master-builder.ts    # fingerprint 単位で master_properties に集約
    image-pipeline.ts    # download_queue → R2 永続化
    archive.ts           # cold archive (R2 JSONL)
    terass-image-fetch.ts
migrations/
  0001_initial.sql / 0002_status_sites.sql /
  0003_mysoku_seiyaku.sql / 0004_fingerprint_queue.sql / seed.sql
scripts/
  run-auto-import.ps1            # Task Scheduler 実行ラッパ (Chrome CDP 起動 + import)
  extract-terass.mjs             # Playwright で TERASS PICKS から CSV ダウンロード
  terass-extract.js              # ブラウザ実行用 IndexedDB エクスポーター
  terass_convert_and_import.mjs  # CSV → D1 import
  auto-import-terass.sh          # 統合 fallback 付きラッパ
  health-check.sh / lint.sh / test.sh / deploy.sh
wrangler.toml
```

---

## API エンドポイント

### パブリック API

| エンドポイント | 説明 |
|--------------|------|
| `GET /api/search` | 個別物件検索 (D1 + ライブスクレイピング) |
| `GET /api/search/master` | マスター物件検索 (fingerprint 統合済) |
| `GET /api/properties/:id` | 物件詳細 |
| `GET /api/transactions` | 成約事例一覧 |
| `GET /api/suggest?q=` | 入力補完 (駅名・地名・物件名) |
| `GET /api/stats` | 公開統計 |
| `GET /api/health` | ヘルスチェック (version 含む) |
| `GET /api/images/*` | R2 画像配信 (path traversal 防御済) |
| `GET /api/scrape/status` | 直近スクレイピング状況 |
| `GET /manifest.json` | PWA manifest |

### 管理 API (`/api/admin/*` — 認可必要)

| エンドポイント | 説明 |
|--------------|------|
| `GET /admin/stats` | 全体統計 (件数 / 重複 / R2/D1 サイズ) |
| `GET /admin/d1-capacity` | D1 容量モニタ (PRAGMA 実値) |
| `GET /admin/export.csv` | CSV エクスポート (max 500,000 行) |
| `GET /admin/archive/list` | R2 アーカイブ一覧 |
| `POST /admin/archive-cold` | sold/delisted を R2 退避 |
| `POST /admin/build-masters` | master_properties 再構築 |
| `POST /admin/download-queue/process` | 画像 download_queue 処理 |
| `POST /admin/discover-terass-images` | TERASS 画像 URL 探索 |

### `/api/search` 主要パラメータ

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `q` | string | フリーワード |
| `prefecture` | string | 都道府県コード (01-47) |
| `city` | string | 市区町村名 |
| `type` | string | 物件種別 |
| `price_min` / `price_max` | number | 価格 (万円) |
| `area_min` / `area_max` | number | 面積 (m²) |
| `rooms` | string | 間取り (例: 3LDK) |
| `age_max` | number | 最大築年数 |
| `station_min` | number | 駅徒歩分数以内 |
| `yield_min` | number | 利回り (%) 下限 |
| `sites` | string | 対象サイト (カンマ区切り) |
| `sort` | string | 並び順 |
| `page` / `limit` | number | ページ番号 / 1ページあたり件数 (最大100) |

---

## データベーススキーマ (主要テーブル)

```sql
properties           -- 物件メインテーブル (UNIQUE(site_id, site_property_id))
master_properties    -- fingerprint 単位の重複統合済マスター
property_images      -- 物件画像 (R2 key 含む)
property_mysoku      -- マイソク PDF メタ
property_features    -- 設備・特徴タグ
price_history        -- 価格変動履歴
transaction_records  -- 成約事例
scrape_jobs          -- スクレイピングジョブ管理
csv_imports          -- CSV インポート履歴
download_queue       -- 画像ダウンロードキュー
search_logs          -- 検索ログ
```

> **注意**: `properties.detail_url` は `NOT NULL`。INSERT 時に NULL を渡すと
> `INSERT OR IGNORE` で無視されるため、空文字 `''` を使うこと。

---

## スクレイピングについて

各スクレイパーは `BaseScraper` を継承:

- **レート制限** - サイトごとに分あたりのリクエスト数を制限
- **リトライ** - 最大3回の指数バックオフ
- **タイムアウト** - 15秒
- **モックデータフォールバック** - 失敗時の劣化応答

> **本番運用**: 各サイトの利用規約を確認し、適切なレート制限と倫理的なクロール実践を遵守。

---

## TERASS PICKS 自動取り込みフロー

```
[Windows Task Scheduler 03:00]
  → run-auto-import.ps1
    → Chrome CDP 起動 (--user-data-dir=%APPDATA%\Chrome_CDP) ※ログインセッション永続化
    → auto-import-terass.sh
      → extract-terass.mjs (Playwright で IndexedDB → CSV ダウンロード)
        ├ ログイン切れ検出 (URL チェック) → exit 1
        └ 0件ダウンロード検出 → exit 2
      → terass_convert_and_import.mjs (D1 import)
    → Chrome グレースフル終了 (CloseMainWindow → cookies 永続化)
```

- ログ: `C:\Users\reale\Downloads\terass_cron.log` (5MB rotate / 30日保持)
- 一度ログインすれば `Chrome_CDP` プロファイルにセッションが永続化されるため、
  以降の cron は再ログイン不要。

---

## 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `ENVIRONMENT` | production | 実行環境 |
| `APP_VERSION` | 6.2.0 | アプリバージョン |
| `MAX_RESULTS_PER_SITE` | 15 | サイトごとの最大取得件数 |
| `CACHE_TTL_SECONDS` | 3600 | キャッシュ有効期間 (秒) |
| `RATE_LIMIT_PER_MINUTE` | 60 | 全体レート制限 |

---

## セッション間同期 (Desktop / Web / iOS)

詳細は `CLAUDE.md` の「セッション間同期プロトコル」を参照。
要点:
- セッション開始時に `git fetch origin` + `BUILD_LOG.md` 確認
- 作業完了時に `BUILD_LOG.md` 追記 + `git push`
- `wrangler deploy` は Desktop のみ可能

---

## ライセンス

Private - All rights reserved

---

## バージョン履歴

- **v6.2.0** (2026-04-22) - R2/D1 サイズ実値計算、検索オートコンプリート、UI 可読性改善、用語ツールチップ、TERASS ログイン永続化、fail-fast 検出
- **v6.0.0** (2026-04) - master_properties 統合、9サイト対応、TERASS PICKS パイプライン
- **v5.0.0** (2026-04-12) - 初期リリース。7サイト統合、47都道府県対応、Cloudflare Workers展開
