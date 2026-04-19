# スクレイパー HTMLパース改修 設計提案

**作成日**: 2026-04-19
**ステータス**: 提案 (未着手)
**推定工数**: 2〜4週間 (9サイト × 各2〜4日)
**優先度**: 高（live data取得を可能にする）

---

## 現状の問題

### 症状
- `lastScrapeAt: null` — 一度もスクレイピングが「成功」記録されていない
- 全データはCSV経由のインポートのみ (TERASS PICKS の 926,226件)

### 根本原因
全9サイトのスクレイパー (`src/scrapers/{suumo,homes,athome,fudosan,chintai,smaity,reins,kenbiya,rakumachi}.ts`) は実装されているが、HTMLパースに失敗 → `getMockData()` フォールバック → `aggregator.ts:191` の `isAllMockData()` ガードが発動 → DB書込スキップ。

### 技術的負債
- regex式のHTML解析 → サイト構造変更に脆弱
- アンチボット対策（Cloudflare/reCAPTCHA）への対応なし
- レート制限実装なし

---

## 改修方針 (3つの選択肢)

### Option A: HTMLパーサーライブラリ導入【推奨】
- **方法**: `linkedom` または `node-html-parser` を導入し、CSSセレクタ + 構造化データ (`application/ld+json`) を解析
- **コスト**: 2〜4日/サイト × 9 = 約3週間
- **メリット**: 既存設計を活かせる、Workersランタイムで動作可能（linkedom使用時）
- **デメリット**: サイト構造変更に追従コスト

### Option B: 公式API/RSSへの切替
- **方法**: REINS/SUUMO等のXMLフィードやAPI連携を交渉
- **コスト**: 営業コスト（技術ではない）
- **メリット**: 安定・高速・規約遵守
- **デメリット**: B2B契約必要、コストもかかる

### Option C: TERASS PICKSに統一【最小コスト】
- **方法**: スクレイパーを廃止し、TERASS PICKS (terass-agents) からの定期CSVインポートに一本化
- **コスト**: 数日（既存インポートを cron 化）
- **メリット**: 既に動作実績あり、9サイト分の正規化済みデータが取れる
- **デメリット**: TERASSアカウントへの依存、TERASSが落ちると全停止

---

## 推奨アプローチ: Option C → A の段階的移行

### Phase 1 (即時着手可能・1週間)
1. TERASS PICKS の Chrome IndexedDB → CSV → D1 自動化
   - ブラウザ拡張または Playwright 経由で日次自動化
   - 既存 `d1_bulk_import_v2.mjs` を cron 起動
   - `csv_imports` 自動記録（実装済）
2. これで `lastCsvImportAt` が日次更新され、データ鮮度が確保される

**Phase 1 スケルトン実装済**:
- `scripts/auto-import-terass.sh` — cron 起動用トリガースクリプト
- 実行: `./scripts/auto-import-terass.sh` または Task Scheduler 登録
- 残作業: TERASS PICKS → CSV 抽出部分（Playwright/Chrome拡張）
- バックエンドは既存 `POST /api/admin/import` または `d1_bulk_import_v2.mjs` で対応可能

### Phase 2 (Phase 1 安定後・3週間)
1. 高優先度2サイト (SUUMO, AtHome) で Option A 適用
2. linkedom 導入、CSSセレクタベース実装
3. アンチボット対策 (User-Agent rotation, fetch間隔調整)
4. `isAllMockData()` ガードを「サイトごと判定」に変更

### Phase 3 (Phase 2 検証後・継続)
1. 残り7サイトを順次 Option A 化
2. パース失敗時のアラート設定 (monitor agent)

---

## 実装時の注意

### Cloudflare Workers 制約
- CPU 50ms 制限 → 重いHTMLパースは Cron Trigger で回避
- `fetch` で取得した HTML は ストリーミングではなく全読込のため、メモリ128MB制限注意
- `linkedom` は Workers 互換、`jsdom` は不可

### 依存サイトの規約
- 各サイトの `robots.txt` 確認
- 利用規約でスクレイピング禁止が明記されていないか
- 商用利用の場合は法務確認必須

---

## 関連ファイル

実装時に修正が必要:
- `src/scrapers/base.ts` — フェッチ＆パース基底クラス
- `src/scrapers/{site}.ts` — 各サイトのセレクタ実装
- `src/scrapers/aggregator.ts:191` — `isAllMockData()` のロジック緩和
- `src/db/queries.ts` — `lastScrapeAt` を `scrape_jobs` テーブルから取得

新規追加:
- `src/parsers/html-parser.ts` — linkedom ラッパー
- `src/parsers/schema-org.ts` — JSON-LD 抽出ヘルパー

---

## 結論

**現セッションでは見送り**。TERASS PICKS データ926kで本番運用に必要なボリュームは確保できているため、まずは画像パイプライン (実装済) と検索UX改善に注力するのが ROI 高い。スクレイパー改修は専用セッションで Phase 1 から段階的に。
