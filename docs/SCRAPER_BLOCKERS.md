# Scraper Blockers — 4-Site Investigation

Last updated: 2026-04-19

---

## Summary Table

| Site | Status | Blocker Category | Recommended Action |
|------|--------|------------------|--------------------|
| SUUMO | Blocked | Cookie / session auth | Use public search-URL API pattern |
| 不動産Japan (fudosan) | DNS ERROR | Domain mismatch (NXDOMAIN) | Switch to correct domain `fudosan.co.jp` |
| REINS | Legally blocked | Member-only MLS | Use Dump CSV / MLIT open-data alternative |
| Smaity | Technically blocked | SPA (Vue), dynamic render | Requires headless browser; defer or remove |

---

## 1. SUUMO

### 現状
`src/scrapers/suumo.ts` でHTMLを直接フェッチ。実行すると HTTP 403 または空レスポンスが返る。

### ブロッカー詳細

| 項目 | 詳細 |
|------|------|
| ブロック手法 | Cloudflare Workers からのリクエストに対し Bot Check / Cookie Guard |
| 必要な Cookie | `SUUMO_BT` (session token)、`suumo_userid` (ユーザー追跡 ID) |
| User-Agent 要件 | Desktop UA が必要。CF Workers のデフォルト UA は拒否される |
| Referer 要件 | `https://suumo.jp/` が Referer として必要なルートあり |
| Rate limit | IP あたり ~5 req/s。Workers からのバースト = 即 BAN |

### 解決オプション

| # | 案 | 工数 | リスク |
|---|----|----|------|
| A | **公開検索 URL のクエリパラメータ方式** に移行 (`/jj/bukken/ichiran/JJ010FJ001/` エンドポイント、query string で絞り込み) — 静的 HTML を返すルートが存在する | 中 | JS 描画部分は欠落 |
| B | **Cloudflare Browser Rendering** (Puppeteer API) を Workers から呼び出す | 高 | 有料プラン必要。レート制限あり |
| C | **外部プロキシ経由でのスクレイプ** (Bright Data / Oxylabs 等) | 高 | コスト増。利用規約要確認 |

### 推奨アクション
**Option A**: `suumo.ts` を公開検索 URL 方式にリライト。Cookie なしで動く `/bukken/ichiran/` エンドポイントへ切り替え、linkedom でパース。

---

## 2. 不動産Japan (fudosan)

### 現状
`src/scrapers/fudosan.ts` および `SITES` 定義で URL を `https://fudosan.jp` に設定。フェッチ時 NXDOMAIN エラー。

### ブロッカー詳細

| 項目 | 詳細 |
|------|------|
| 問題 | `fudosan.jp` は実在しない / DNS 解決不能 (NXDOMAIN) |
| 正しいドメイン | `https://www.fudosan.co.jp` (不動産ジャパン — 全国宅地建物取引業協会連合会運営) |
| wrangler.toml 影響 | `outbound_allowlist` に `fudosan.jp` が含まれているなら `fudosan.co.jp` に変更が必要 |

### 解決オプション

| # | 案 | 工数 | リスク |
|---|----|----|------|
| A | **ドメインを `fudosan.co.jp` に修正** + `wrangler.toml` の allowlist 更新 | 低 | 軽微 |
| B | fudosan.co.jp のスクレイプ可否を事前に手動確認してから修正 | 低-中 | — |
| C | サイトを一時的に disabled に設定し後回し | 低 | スキャン件数減 |

### 推奨アクション
**Option A**: `src/types/index.ts` の `SITES.fudosan.url` と `src/scrapers/fudosan.ts` の対象 URL を `https://www.fudosan.co.jp` に修正。`wrangler.toml` allowlist も合わせて更新。

---

## 3. REINS

### 現状
`src/scrapers/reins.ts` は形式的に存在するが、実際には会員認証が必要なため scrape 不可能。

### ブロッカー詳細

| 項目 | 詳細 |
|------|------|
| 運営 | 公益財団法人 不動産流通推進センター (REINS = Real Estate Information Network System) |
| アクセス要件 | 宅地建物取引業者のみが会員登録可能。ID/PW なしで閲覧不可 |
| 法的リスク | 会員契約の「目的外利用禁止」条項により、スクレイピングは利用規約違反となる可能性が高い |
| 技術的ブロック | ログインページ以外は全て 302 リダイレクト + CSRF トークン |

### 解決オプション

| # | 案 | 工数 | リスク |
|---|----|----|------|
| A | **MLIT (国土交通省) 土地総合情報システム API** を代替として利用 — 成約価格の公開 Open Data が存在する | 中 | データが成約済みのみ。掲載物件は含まれない |
| B | TERASS データ (`terass_reins` site_id) をそのまま活用 — TERASS PICKS は REINS 掲載物件を独自取得して提供している | 低 | 既に実装済み |
| C | `reins.ts` スクレイパーを `disabled: true` に設定し、cron から除外 | 低 | 将来対応の余地を残す |

### 推奨アクション
**Option B + C**: TERASS 経由データを主ソースとして維持。`reins.ts` の scrape を cron 対象から除外し、コード内に法的理由コメントを追記。MLIT API は別タスクとして検討。

---

## 4. Smaity

### 現状
`src/scrapers/smaity.ts` で HTML フェッチ → linkedom パース。しかしほぼ空のレスポンス (骨格 HTML のみ)。

### ブロッカー詳細

| 項目 | 詳細 |
|------|------|
| レンダリング方式 | SPA (Vue.js または React ベース)。初期 HTML は `<div id="app"></div>` のみ |
| データ取得方法 | クライアント JS が `/api/v1/properties` 等の JSON エンドポイントを呼び出して描画 |
| Workers の限界 | `linkedom` は静的 HTML パーサー。JS 実行はできない |
| 内部 API 認証 | XHR エンドポイントには CSRF トークン / JWT が必要と推定 |

### 解決オプション

| # | 案 | 工数 | リスク |
|---|----|----|------|
| A | **Cloudflare Browser Rendering** (Puppeteer) を使用して JS 実行後の DOM を取得 | 高 | 有料 Workers Paid プラン必要 |
| B | ブラウザで XHR を記録し **内部 API エンドポイントを直接叩く** (認証不要なエンドポイントが存在するか調査) | 中 | 認証必要なら困難。仕様変更で壊れる |
| C | **スクレイパーを一時停止** し、`SITES.smaity` を disabled 扱いに設定。cron 対象から除外 | 低 | データなし |

### 推奨アクション
**Option C (短期) → Option B (中期)**: まず smaity を cron から除外してノイズを減らす。並行してブラウザ DevTools で公開 API エンドポイントを調査。認証不要エンドポイントが見つかれば Option B を実装。

---

## 共通推奨アクション優先度

| 優先 | サイト | アクション |
|------|--------|----------|
| 高 | 不動産Japan | ドメイン修正 (`fudosan.co.jp`) → 即修正可能 |
| 中 | SUUMO | 公開検索 URL 方式リライト |
| 低 | REINS | cron 除外 + TERASS 継続活用 |
| 低 | Smaity | cron 除外 + 内部 API 調査 |
