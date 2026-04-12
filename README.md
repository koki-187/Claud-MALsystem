# 🌎 MAL検索システム v5.0
## My Agent Locator - 47都道府県・7サイト横断 不動産情報統合検索システム

---

## 概要

MAL（My Agent Locator）は、日本全国47都道府県の主要不動産7サイトを横断検索するシステムです。
Cloudflare Workers + Hono v4 + TypeScript で構築されており、エッジで高速に動作します。

### 対応サイト

| サイト | 種別 | 特徴 |
|--------|------|------|
| 🏠 SUUMO | 売買・賃貸 | 日本最大級の不動産情報サイト |
| 🏡 HOME'S | 売買・賃貸 | 豊富な物件データベース |
| 🏘 AtHome | 売買・賃貸 | 全国の不動産会社が掲載 |
| 🏗 不動産Japan | 売買 | 国土交通省系の信頼性高い情報 |
| 🏢 CHINTAI | 賃貸専門 | 賃貸物件に特化したサービス |
| 🏬 Smaity | 投資・売買 | 投資用物件に強み |
| 📋 REINS | 業者向け | 不動産流通機構のレインズ登録物件 |

---

## 機能一覧

- **47都道府県横断検索** - 全国の物件を一度に検索
- **7サイト統合API** - 複数サイトの情報を並列取得・統合
- **高度なフィルタリング** - 価格・面積・間取り・築年数・駅徒歩など
- **リアルタイムスクレイピング** - DBに物件がない場合は自動でライブ取得
- **KVキャッシュ** - 検索結果を自動キャッシュ（TTL: 1時間）
- **レート制限** - サイトごとのAPIレート管理
- **ダーク/ライトモード** - テーマ切替対応
- **レスポンシブデザイン** - モバイル・タブレット・PC対応
- **PWA対応** - プログレッシブWebアプリ
- **統計ダッシュボード** - サイト別・都道府県別の物件数統計

---

## 技術スタック

```
Framework:   Hono v4.6 + TypeScript
Deploy:      Cloudflare Pages + Workers
Database:    Cloudflare D1 (SQLite)
Cache:       Cloudflare KV
Storage:     Cloudflare R2
Frontend:    Vanilla JS + Tailwind CSS (CDN) + Font Awesome
```

---

## セットアップ

### 前提条件

- Node.js 18+
- Cloudflare アカウント
- Wrangler CLI

### インストール

```bash
npm install
```

### 環境設定

1. `wrangler.toml` の `database_id` と KV `id` を実際の値に更新:

```bash
# D1 データベース作成
wrangler d1 create mal-search-db

# KV ネームスペース作成
wrangler kv:namespace create MAL_CACHE

# R2 バケット作成
wrangler r2 bucket create mal-property-images
```

2. 取得したIDを `wrangler.toml` に設定

### データベース初期化

```bash
# マイグレーション実行
npm run db:migrate

# サンプルデータ投入
npm run db:seed
```

### ローカル開発

```bash
npm run dev
```

ブラウザで `http://localhost:8788` にアクセス

### デプロイ

```bash
npm run deploy
```

---

## プロジェクト構造

```
mal-search-system/
├── src/
│   ├── index.tsx          # メインエントリーポイント + フロントエンドHTML
│   ├── types/
│   │   └── index.ts       # TypeScript型定義・定数
│   ├── db/
│   │   └── queries.ts     # D1データベースクエリ関数
│   ├── scrapers/
│   │   ├── base.ts        # ベーススクレイパークラス
│   │   ├── aggregator.ts  # 全サイト並列スクレイピング
│   │   ├── suumo.ts       # SUUMOスクレイパー
│   │   ├── homes.ts       # HOME'Sスクレイパー
│   │   ├── athome.ts      # AtHomeスクレイパー
│   │   ├── fudosan.ts     # 不動産Japanスクレイパー
│   │   ├── chintai.ts     # CHINTAIスクレイパー
│   │   ├── smaity.ts      # Smaityスクレイパー
│   │   └── reins.ts       # REINSスクレイパー
│   └── routes/
│       └── search.ts      # 検索APIルーター
├── migrations/
│   ├── 0001_initial.sql   # 初期スキーマ
│   └── seed.sql           # サンプルデータ
├── package.json
├── tsconfig.json
├── wrangler.toml
└── README.md
```

---

## API エンドポイント

### `GET /api/search`

物件を検索します。

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `q` | string | フリーワード |
| `prefecture` | string | 都道府県コード（01-47） |
| `city` | string | 市区町村名 |
| `type` | string | 物件種別 |
| `price_min` | number | 最低価格（万円） |
| `price_max` | number | 最高価格（万円） |
| `area_min` | number | 最小面積（m²） |
| `area_max` | number | 最大面積（m²） |
| `rooms` | string | 間取り（例: 3LDK） |
| `age_max` | number | 最大築年数 |
| `station_min` | number | 駅徒歩分数以内 |
| `sites` | string | 対象サイト（カンマ区切り） |
| `sort` | string | 並び順 |
| `page` | number | ページ番号 |
| `limit` | number | 1ページあたり件数（最大100） |

**レスポンス例:**
```json
{
  "properties": [...],
  "total": 150,
  "page": 1,
  "limit": 20,
  "totalPages": 8,
  "sites": [
    { "siteId": "suumo", "count": 45, "status": "success", "executionTimeMs": 320 }
  ],
  "executionTimeMs": 450,
  "cacheHit": false
}
```

### `GET /api/properties/:id`

物件詳細を取得します。

### `GET /api/stats`

システム統計を取得します。

### `GET /api/suggest?q=`

入力補完（市区町村名）を取得します。

### `GET /api/health`

ヘルスチェック。

---

## データベーススキーマ

```sql
properties          -- 物件メインテーブル
property_images     -- 物件画像
property_features   -- 設備・特徴タグ
price_history       -- 価格変動履歴
scrape_jobs         -- スクレイピングジョブ管理
search_logs         -- 検索ログ
favorites           -- お気に入り（セッションベース）
```

---

## スクレイピングについて

各サイトのスクレイパーは `BaseScraper` を継承し、以下の機能を実装しています:

- **レート制限** - サイトごとに分あたりのリクエスト数を制限
- **リトライ機能** - 最大3回の自動リトライ（指数バックオフ）
- **タイムアウト** - 15秒でタイムアウト
- **モックデータフォールバック** - スクレイピング失敗時はモックデータを返却
- **User-Agent設定** - 識別可能なボットUAを使用

> **注意**: 実際の本番運用では、各サイトの利用規約を確認し、適切なレート制限と倫理的なクロール実践を遵守してください。

---

## 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `ENVIRONMENT` | production | 実行環境 |
| `APP_VERSION` | 5.0.0 | アプリバージョン |
| `MAX_RESULTS_PER_SITE` | 15 | サイトごとの最大取得件数 |
| `CACHE_TTL_SECONDS` | 3600 | キャッシュ有効期間（秒） |
| `RATE_LIMIT_PER_MINUTE` | 60 | 全体レート制限 |

---

## ライセンス

Private - All rights reserved

---

## バージョン履歴

- **v5.0.0** (2026-04-12) - 初期リリース。7サイト統合、47都道府県対応、Cloudflare Workers展開
