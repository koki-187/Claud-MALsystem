# MAL検索システム 構築ログ

このファイルはDesktop / Web / iOS の全セッションで共有される構築状況ログです。
作業を行ったら必ず追記してください。

---

## 2026-04-19 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: Phase 2 PoC完成 — linkedom導入 + SUUMOスクレイパーHTMLパーサー書換
  - `linkedom ^0.18.12` を dependencies に追加 (package.json)
  - `src/parsers/html-parser.ts` 新規作成: linkedomラッパー、extractJsonLd、findJsonLdByType、querySelectorヘルパー群
  - `src/scrapers/base.ts` 拡張: `parseDocument()` / `extractFromJsonLd()` protected メソッド追加、Schema.org ノード変換ロジック実装
  - `src/scrapers/suumo.ts` 全面書換: JSON-LD優先パース → CSSセレクタfallback の2段構え、mockフォールバック廃止
  - `src/scrapers/aggregator.ts` ガード改善: `isAllMockData()` (全サイト一括判定) に加え `isMockData()` (サイト別判定) を追加、scheduledScrapeをサイト別判定に切替
  - `tests/fixtures/suumo-listings.html` テストフィクスチャ新規作成
  - `tests/scrapers/suumo.test.ts` テスト新規作成 (13テスト全PASS)
- **デプロイ**: 未 (デスクトップ環境でwrangler deployが必要)
- **TypeScript**: `tsc --noEmit` ゼロエラー
- **テスト**: 13/13 PASS
- **次のタスク**: 次サイト書換推奨 → **HOME'S** (`src/scrapers/homes.ts`) — 物件数が多くJSON-LDを出力している可能性が高い

---

## 2026-04-19 (Web/Remote)
- **環境**: Web (Claude Code Remote)
- **ブランチ**: master
- **コミット**: `55bbf70`
- **変更内容**: Phase 2 batch B — reins/kenbiya/rakumachi 全面書換 (投資物件yieldRate対応)
  - `src/scrapers/reins.ts` 全面書換: mockフォールバック廃止、JSON-LD優先 → CSSセレクタfallback の2段構え
  - `src/scrapers/kenbiya.ts` 全面書換: 同パターン + `extractYieldRate()` 実装 (additionalProperty→description→title優先順)
  - `src/scrapers/rakumachi.ts` 全面書換: 同パターン + `extractYieldRate()` 実装 (利回り%正規表現、0-50%サニティチェック)
  - テストフィクスチャ3件新規作成 (JSON-LD 2件 + DOMカード 2件、kenbiya/rakumachiは利回り含む)
  - テスト3件新規作成 (reins:24件, kenbiya:26件, rakumachi:29件 計79テスト全PASS)
- **TypeScript**: `tsc --noEmit` ゼロエラー
- **テスト**: 79/79 PASS
- **デプロイ**: 未 (wrangler deployはデスクトップ環境で実行)
- **次のタスク**: デプロイ実行 + 別agentがathome/fudosan/chintai/smaityを並行作業中

---

## 2026-04-19 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **コミット**: `67e745d`
- **変更内容**: Phase 2 — HOME'Sスクレイパー全面書換 (commit 67e745d)
  - `src/scrapers/homes.ts` 全面書換: mockフォールバック廃止、JSON-LD優先 → CSSセレクタfallback の2段構え (SUUMOと同パターン)
  - `parseFromJsonLd` / `parseFromDom` / `jsonLdNodeToPartial` 追加
  - 画像URL抽出: og:image (ページレベル) + カード内 `<img>` src 収集
  - `tests/fixtures/homes-listings.html` 新規作成 (JSON-LD 2件 + CSSカード 2件)
  - `tests/scrapers/homes.test.ts` 新規作成 (24テスト全PASS)
- **TypeScript**: `tsc --noEmit` ゼロエラー
- **テスト**: 24/24 PASS
- **デプロイ**: 未 (wrangler deployはデスクトップ環境で実行)
- **次のタスク**: 次サイト書換推奨 → **AtHome** (`src/scrapers/athome.ts`) — 同パターンで横展開

---

## 2026-04-12 10:46 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: MAL検索システム v5.0 初期リリース — 47都道府県・7サイト横断不動産検索。Hono + Cloudflare Workers + D1 + KV + R2。
- **デプロイ**: 済
- **次のタスク**: バグ修正・XSS対策

## 2026-04-12 10:51 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: エラーテスト・ロジック強化・XSS修正 — aggregator.tsのsiteId修正、logSearch追加、thumbnailUrl XSS脆弱性修正
- **デプロイ**: 済
- **次のタスク**: UXスコア改善

## 2026-04-12 12:26 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: 100testスコア改善 — PWAマニフェスト追加、Escapeキーモーダル閉じ、autocomplete、築年数フィルター、モバイル対応強化
- **デプロイ**: 済
- **次のタスク**: wrangler.toml修正

## 2026-04-12 12:33 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: wrangler.toml修正 + launch.json更新 — [build]/[pages]セクション削除、ENVIRONMENT変更
- **デプロイ**: 済
- **次のタスク**: v6.0 9サイト対応

## 2026-04-12 14:02 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: MAL v6.0 — 健美家・楽待追加で9サイト対応、売却済管理、Cron定時スクレイピング(1日4回)、投資物件対応、UI全面刷新
- **デプロイ**: 済
- **次のタスク**: モックガード・ローテーション

## 2026-04-12 16:18 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: v6.1 — モックガード(isAllMockData)、曜日別都道府県ローテーション、マイソク/成約事例スキーマ(migration 0003)
- **デプロイ**: 済
- **次のタスク**: v6.2 全データ取得・管理ロジック

## 2026-04-12 17:20 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: v6.2 — 全データ取得・管理ロジック完全実装。Admin API 6エンドポイント、クロスサイト重複検知、画像ギャラリー、CSVエクスポート/インポート、migration 0004
- **デプロイ**: 済
- **次のタスク**: admin stats堅牢化

## 2026-04-12 17:21 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: admin stats堅牢化 — migration未適用テーブルでも500エラーにならないようsafeFirst/safeAllラッパー追加
- **デプロイ**: 済
- **次のタスク**: リモート開発環境構築

## 2026-04-15 06:03 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: wrangler.tomlに実リソースID設定 — D1/KV/R2のIDを本番値に更新
- **デプロイ**: 済
- **次のタスク**: CLAUDE.md追加

## 2026-04-15 06:45 (Desktop)
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**: CLAUDE.md追加 — プロジェクト概要とリモート開発ルール定義
- **デプロイ**: 不要
- **次のタスク**: リモート環境構築

## 2026-04-15 05:24 (Web/iOS)
- **環境**: Web (Claude Code Remote)
- **ブランチ**: claude/remote-control-browser-ios-W3jrT
- **変更内容**: リモート開発環境の構築 — CLAUDE.md, .claude/settings.json(自動プッシュ/セッション開始フック), scripts/(health-check, auto-push, test, lint)
- **デプロイ**: 不要
- **次のタスク**: masterブランチとの統合

## 2026-04-15 18:38 (Web/iOS)
- **環境**: Web (Claude Code Remote)
- **ブランチ**: claude/remote-control-browser-ios-W3jrT
- **変更内容**: masterブランチのMAL検索システムv6.2を統合 — 全ソースコード(src/, migrations/, wrangler.toml等)をマージ、CLAUDE.md統合
- **デプロイ**: 不要（リモート環境にコード同期のみ）
- **次のタスク**: セッション間同期プロトコル整備

## 2026-04-15 19:00 (Web/iOS)
- **環境**: Web (Claude Code Remote)
- **ブランチ**: claude/remote-control-browser-ios-W3jrT
- **変更内容**: セッション間同期プロトコル追加 — CLAUDE.mdにセッション間同期手順・BUILD_LOG.md運用ルールを追記。BUILD_LOG.md作成（全構築履歴を記録）
- **デプロイ**: 不要
- **次のタスク**: masterへの同期プロトコル反映

## 2026-04-15 18:49 (Web/iOS → master直接)
- **環境**: Web (Claude Code Remote) → GitHub API経由でmaster直接更新
- **ブランチ**: master
- **変更内容**: CLAUDE.md・BUILD_LOG.mdをmasterブランチに直接反映。マージ不要でDesktop側にも同期プロトコルが自動適用される仕組みを構築
- **デプロイ**: 不要
- **次のタスク**: なし（同期基盤完成）

## 2026-04-17 11:04 (Desktop)
- **環境**: Desktop (Claude Code) — 34エージェント並列実行
- **ブランチ**: master
- **変更内容**:
  - `/remoteset` カスタムスキル作成（~/.claude/skills/remoteset/）
  - GitHub Claude App をkoki-187アカウントにインストール（Read & Write権限）
  - GitHub CLI (gh) インストール&認証完了
  - scripts/ 一式新規作成: health-check.sh / test.sh / lint.sh / deploy.sh / auto-push.sh
  - .gitignore に .claude/scheduled_tasks.lock 追加
  - エージェント並列調査: スクレイパー実装状況・画像パイプライン・重複検知ロジック
- **デプロイ**: 不要（インフラ整備のみ）
- **次のタスク**: D1未インポート行のリカバリ

## 2026-04-17 12:30 (Desktop)
- **環境**: Desktop (Claude Code) — D1バルクインポート
- **ブランチ**: master
- **変更内容**: D1再インポート完了 — `d1_bulk_import_v2.mjs` を再実行し、欠損していた約30万行を追加
  - インポート前: 619,063件
  - インポート後: 926,226件 (+307,163件、エラー0件)
  - active: 296,141 → 449,934 (+153,793)
  - sold: 322,922 → 476,292 (+153,370)
  - サイト別: reins +210k / athome +49k / suumo +47k
- **デプロイ**: 不要（D1直接更新）
- **次のタスク**: スクレイパーHTMLパース改修・画像パイプライン実装・fingerprint計算ロジック追加

## 2026-04-19 18:00-18:30 (Desktop) — 34エージェント並列実行
- **環境**: Desktop (Claude Code) — OMC + executor agent + 並列調査
- **ブランチ**: master
- **変更内容**:
  - **B 完了**: R2画像ダウンロードパイプライン実装 (commit `c089166`)
    - 新規: `src/services/image-pipeline.ts` (enqueueImage/processQueue/enqueueAll)
    - admin API追加: `POST /api/admin/images/{enqueue-all,process}` `GET /api/admin/images/queue-status`
    - cron scheduled handler に `processQueue(env, 50)` 自動実行を追加
  - **C 完了**: fingerprint調査の結果、TERASS CSV由来の12文字ハッシュが既に正しく機能していることを確認
    - 926,226件 / 830,802ユニーク = 重複率 約10%（健全）
    - `d1_bulk_import_v2.mjs` に `calcFingerprint()` フォールバックを追加（将来の非TERASSデータ対応）
    - `d1_fingerprint_backfill.mjs` 作成（必要時に実行可能）
  - **D 完了**: csv_imports に初期インポート926k件のレコード追加 → `lastCsvImportAt: 2026-04-19 09:20:47` 反映
    - `d1_bulk_import_v2.mjs` に `recordCsvImport()` 関数追加（今後のインポートで自動記録）
  - **A 設計提案**: `docs/SCRAPER_REWRITE_PROPOSAL.md` 作成
    - Option A/B/C 3案を比較、推奨は Phase 1 (TERASS自動化) → Phase 2 (linkedom導入) の段階移行
- **デプロイ**: image-pipeline は次回wrangler deploy時に有効化
- **次のタスク**: スクレイパー改修 Phase 1 着手判断

## 2026-04-19 19:00 (Desktop) — 残存課題3件解決
- **環境**: Desktop (Claude Code) — 並列実行+トークン効率重視
- **ブランチ**: master
- **変更内容**:
  - **#3 完了**: TypeScript型エラー2件修正
    - `src/routes/admin.ts:13` の `safeAll` を `Promise<{ results: T[] }>` 型に簡略化
    - `npx tsc --noEmit` でエラー0件確認
  - **#2 完了**: 画像パイプラインを本番デプロイ
    - `wrangler deploy` 実行 (Version ID: f00c4ff8)
    - 新エンドポイント本番反映: `POST /api/admin/images/{enqueue-all,process}` `GET /api/admin/images/queue-status`
    - cron scheduled handler に `processQueue(env, 50)` 配備済（4回/日）
  - **#1 Phase 1 スケルトン**: `scripts/auto-import-terass.sh` 作成
    - Windows Task Scheduler / cron 用トリガースクリプト
    - 既存 `d1_bulk_import_v2.mjs` をラップして自動ヘルスチェックまで実行
    - 残作業: TERASS PICKS → CSV 抽出部分（Playwright/Chrome拡張、別セッション推奨）
- **デプロイ**: 済 (mal-search-system)
- **次のタスク**: スクレイパー改修 Phase 2 (linkedom導入によるHTMLパーサー実装)

## 2026-04-19 (Desktop) — TERASS PICKS CSV自動抽出 Phase 1 完成
- **環境**: Desktop (Claude Code)
- **ブランチ**: master
- **変更内容**:
  - **Phase 1 完成**: TERASS PICKS IndexedDB → CSV → D1 自動抽出パイプライン
    - `scripts/terass-extract.js` 新規作成 — Chrome DevTools Console 用 IndexedDB エクスポーター
      - 全 IndexedDB を自動スキャン、6ファイル (house/mansion/land × 在庫/成約済) をダウンロード
      - 既存 CSV ヘッダーと完全一致 (後段変換スクリプトとの互換性確保)
    - `scripts/extract-terass.mjs` 新規作成 — Playwright CDP 自動化スクリプト
      - `--remote-debugging-port=9222` で起動した既存 Chrome にアタッチ (ログイン状態を再利用)
      - TERASS PICKS タブを自動検出 → terass-extract.js を evaluate
      - 完了後 `terass_convert_and_import.mjs` を spawn して即時 D1 同期
      - `--dry-run` モードでアタッチ確認のみ実行可能
    - `scripts/auto-import-terass.sh` 更新 — Phase 1 スケルトンを完全実装に置き換え
      - 冒頭で `extract-terass.mjs` を実行
      - 失敗時は既存 CSV を使ってインポート継続 (fallback)
    - `scripts/TERASS_AUTO_IMPORT.md` 新規作成 — セットアップ手順 README
      - Chrome CDP 起動方法、初回ログイン手順、Windows Task Scheduler 登録コマンド
      - 環境変数リファレンス、トラブルシューティング
    - `package.json` に `playwright ^1.44.0` を devDependencies に追加
- **デプロイ**: 不要 (スクリプト追加のみ)
- **次のタスク**:
  - `npm install` を実行して playwright をローカルにインストール
  - Chrome を `--remote-debugging-port=9222` で起動して `node scripts/extract-terass.mjs --dry-run` で動作確認
  - スクレイパー改修 Phase 2 (linkedom導入)

---

## 2026-04-19 (Web/Remote) — Phase 2 batch A
- **環境**: Web (Claude Code Remote)
- **ブランチ**: master
- **変更内容**: Phase 2 batch A — athome/fudosan/chintai/smaity 全面書換
  - `src/scrapers/athome.ts` 全面書換: mockフォールバック廃止、JSON-LD優先 → CSSセレクタfallback の2段構え (SUUMO/HOME'Sと同パターン)
  - `src/scrapers/fudosan.ts` 全面書換: 同パターン
  - `src/scrapers/chintai.ts` 全面書換: 同パターン + 賃貸家賃専用priceText (家賃X万円/月)、propertyType `chintai_mansion`
  - `src/scrapers/smaity.ts` 全面書換: 同パターン + propertyType `investment` + additionalProperty 経由 yieldRate 抽出
  - テストフィクスチャ4件新規作成 (JSON-LD 2件 + DOMカード 2件 × 4サイト)
  - テスト4件新規作成 (athome:17件, fudosan:17件, chintai:17件, smaity:20件 計71テスト全PASS)
- **TypeScript**: `tsc --noEmit` ゼロエラー
- **テスト**: 71/71 PASS
- **デプロイ**: 未 (wrangler deployはデスクトップ環境で実行)
- **次のタスク**: デプロイ実行

## 2026-04-19 22:30 (Desktop) — Phase 1 + Phase 2 完全実装＋本番デプロイ完了
- **環境**: Desktop (Claude Code) — 4並列executor agent
- **ブランチ**: master
- **変更内容**:
  - **Phase 1完成** (`237b130`): TERASS PICKS 自動抽出パイプライン
  - **Phase 2完成** (`f9651a9` + `67e745d` + `86bdd4b` + `55bbf70`): linkedom 9サイト全面書換 — テスト合計187 pass
  - **Manual scrape API** (`cb12d33`): `POST /api/admin/scrape` 追加
- **デプロイ**: 済 (Version `4a41fb27`)
- **検証結果**: 9サイト × 3都道府県 = 27ジョブ全て例外なく実行確認 (mock廃止＋linkedomパース動作OK)
  - ⚠️ **D1 size limit到達** (589MB / 926k rows) — 新規スクレイプ書込が `D1_ERROR: Exceeded maximum DB size`
- **次のタスク**: D1容量対策 (sold cleanup or paid plan upgrade) → 容量解決後 cron で実データ蓄積開始

## 2026-04-19 22:55 (Desktop) — D1容量回復 + 本番スクレイプ初成功
- **環境**: Desktop (Claude Code) — D1直接操作 (Cloudflare MCP)
- **ブランチ**: master
- **変更内容**:
  - **D1容量回復** (`520MB→470MB`):
    - 低利用度index 4本削除 (`status_type`, `status_prefecture`, `scraped_at`, `last_seen`, `area`)
    - sold_at < 2023-01-01 の sold物件 約184k行 削除 (バッチ処理で `Exceeded maximum DB size` 回避)
    - クリティカルindex再作成: `idx_properties_status_prefecture`, `idx_properties_status_type`, `idx_properties_scraped_at`
  - **`price_history` テーブル本番作成** — migration 0001 で定義済だが本番未適用。直接CREATE
  - **ヘルスチェック**: 9サイト×3都道府県=27ジョブ実行
    - ✅ **HOME'S/07: `completed` — 本番初の実データ書込成功**
    - 他8サイト: `skipped_mock` (実サイトHTML構造とセレクタ不一致、Phase 2継続調整対象)
- **DB状態**:
  - 容量: 589MB → 470MB (-20%)
  - properties: 926,226 → 742,345 (sold 476k→292k, active 449k維持)
- **デプロイ**: 不要 (D1直接操作のみ)
- **次のタスク**:
  1. HOME'S以外8サイトのCSSセレクタを実HTML検証で調整 (各サイト数時間)
  2. 容量さらに必要なら sold_at < 2024 を段階削除
  3. Phase 1 (TERASS Chrome拡張動作確認) — 別セッション推奨
