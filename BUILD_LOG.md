# MAL検索システム 構築ログ

このファイルはDesktop / Web / iOS の全セッションで共有される構築状況ログです。
作業を行ったら必ず追記してください。

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
- **次のタスク**: masterブランチへマージ（Desktop側で実施）→ wrangler deploy

## 2026-04-15 20:30 (Web/iOS)
- **環境**: Web (Claude Code Remote)
- **ブランチ**: claude/remote-control-browser-ios-W3jrT
- **変更内容**: v7.0 スクレイパー全面リファクタリング — 本番品質データ収集戦略を実装
  - **BaseScraper強化**: `detectPropertyType()` 動的物件種別判定、`extractFloor()` 階数抽出、`extractAddress()` 住所抽出、`extractCoordinates()` 緯度経度抽出、`assessQuality()` データ品質スコア算出、User-Agent更新
  - **全9サイト共通改善**: 
    - `scrapeDetail()` 詳細ページスクレイピング実装（全9サイト）
    - `detectPropertyType()` でハードコード `'mansion'` → 動的判定（マンション/一戸建て/土地/賃貸/投資/事務所）
    - `extractFloor()` / `extractAge()` をリスティング解析に追加
    - `extractAddress()` による住所抽出追加
  - **投資物件スクレイパー（健美家・楽待）強化**: 駅・築年数・部屋数・階数の抽出を追加
  - **Smaityスクレイパー**: `propertyType` を `'mansion'` → 動的判定に修正、利回り抽出追加
  - **CHINTAIスクレイパー**: 賃貸マンション/賃貸一戸建ての動的判定追加
  - **REINSスクレイパー**: 構文エラー修正、動的物件種別判定・土地面積抽出追加
  - **アグリゲーター v2**: 
    - 14日サイクル都道府県ローテーション（全47都道府県完全カバー）
    - 階層スクレイピング（Tier 1: 一覧 → Tier 2: 詳細ページ自動エンリッチメント）
    - UPSERT改善（building_area, land_area, rooms, age, floor等のCOALESCEマージ）
    - `detailEnriched` カウント追加
  - **CLAUDE.md**: 会話言語ルール追加（全セッション日本語）
- **デプロイ**: 未（Desktop側でmasterマージ後にデプロイ）
- **次のタスク**: Desktop側でmasterマージ → wrangler deploy → 実サイトでのスクレイピング動作検証

## 2026-04-15 21:00 (Web/iOS)
- **環境**: Web (Claude Code Remote)
- **ブランチ**: claude/remote-control-browser-ios-W3jrT
- **変更内容**: v7.0 フロントエンドUI改善 — スクレイパーv7.0で追加した新フィールドをUI全体に反映
  - **バージョン表記更新**: v6.0 → v7.0（ヘッダー・CSS）
  - **物件カード強化 (renderCard)**:
    - 階数表示改善: 「3階/10階建」形式で総階数を表示
    - 構造・向き・建物面積・土地面積を追加情報行として表示
    - データ品質スコアバッジ（高品質/標準/基本）をカード右上に表示
    - 物件種別バッジの位置調整（品質バッジとの共存）
  - **物件詳細モーダル強化 (renderModal)**:
    - 詳細グリッドに「階数」「構造」「向き」を独立項目として追加
    - 面積サブテキストに建物面積・土地面積を表示
    - Google Mapsリンク（緯度経度からワンクリックで地図表示）
    - データ品質スコアメーター（バー表示 + スコア数値）
    - 管理費・修繕積立金を独立表示（構造・向きとの混在を解消）
  - **品質スコア計算 (calcQuality)**: 
    - 15項目の重み付けスコア（価格15点、面積10点、住所10点、タイトル10点、他）
    - 3段階評価: 高品質(70+)/標準(40-69)/基本(0-39)
  - **CSS追加**: 品質バッジ(.prop-quality-badge)、追加スペック行(.prop-specs-extra)、地図リンク(.map-link)、品質メーター(.quality-meter/.quality-bar)
- **デプロイ**: 未（Desktop側でmasterマージ後にデプロイ）
- **次のタスク**: Admin API拡張・DBクエリ最適化

## 2026-04-16 10:00 (Web/iOS)
- **環境**: Web (Claude Code Remote)
- **ブランチ**: claude/remote-control-browser-ios-W3jrT
- **変更内容**: Admin API拡張 + DBクエリ最適化 — v7.0新フィールドをバックエンド全体に反映
  - **Admin API — データ品質レポート (`/api/admin/quality-report`)**:
    - 18項目のフィールド充填率レポート（price, area, rooms, age, floor, totalFloors, station, stationMinutes, address, coordinates, buildingArea, landArea, structure, direction, yieldRate, thumbnail, description, fingerprint）
    - サイト別品質スコア（9フィールドの充填率から算出）
    - 全データをactive物件ベースで集計
  - **DBクエリ最適化 (queries.ts)**:
    - 検索フィルター追加: floorMin, landAreaMin, buildingAreaMin, structure（LIKE検索）, hasCoordinates
    - ソートオプション追加: age_asc（築浅い順）, age_desc（築古い順）, floor_desc（高層階順）
    - upsert COALESCEマージ改善: 全26カラムでCOALESCE — 新データがNULLの場合に既存データを保持
  - **CSVエクスポート改善**: building_area, land_area, total_floors を追加
  - **型定義 (types/index.ts)**:
    - SearchParams に floorMin, landAreaMin, buildingAreaMin, structure, hasCoordinates を追加
    - sortBy に age_asc, age_desc, floor_desc を追加
  - **フロントエンドUI (index.tsx)**:
    - 検索フォーム4行目追加: 構造フィルター（RC造/SRC造/鉄骨/木造/軽量鉄骨）, 階数下限フィルター, 土地面積下限フィルター
    - ソートセレクト拡張: 「築浅い順」「築古い順」「高層階順」を追加
    - フィルターチップに構造・階数・土地面積を反映
    - /api/health バージョン 6.0.0 → 7.0.0
- **デプロイ**: 未（Desktop側でmasterマージ後にデプロイ）
- **次のタスク**: Desktop側でmasterマージ → wrangler deploy → 全機能動作検証
