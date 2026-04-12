-- Migration 0004: クロスサイト重複検知・ダウンロードキュー・CSVインポート・スキーマ強化

-- ── properties テーブル追加フィールド ─────────────────────────────────────────
ALTER TABLE properties ADD COLUMN fingerprint TEXT;           -- クロスサイト重複検知ハッシュ
ALTER TABLE properties ADD COLUMN management_fee INTEGER;     -- 管理費 (円/月)
ALTER TABLE properties ADD COLUMN repair_fund INTEGER;        -- 修繕積立金 (円/月)
ALTER TABLE properties ADD COLUMN direction TEXT;             -- 向き (南向き, 東向き等)
ALTER TABLE properties ADD COLUMN structure TEXT;             -- 構造 (RC造, 木造, SRC造等)
ALTER TABLE properties ADD COLUMN last_seen_at TEXT;          -- 最後にスクレイプで確認された日時
ALTER TABLE properties ADD COLUMN floor_plan_url TEXT;        -- 間取り図URL
ALTER TABLE properties ADD COLUMN exterior_url TEXT;          -- 外観画像URL

CREATE INDEX IF NOT EXISTS idx_properties_fingerprint ON properties(fingerprint);
CREATE INDEX IF NOT EXISTS idx_properties_last_seen   ON properties(last_seen_at);

-- ── price_history UNIQUE制約 (重複挿入防止) ───────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique
  ON price_history(property_id, recorded_at);

-- ── ダウンロードキュー (R2への画像・PDFダウンロード管理) ──────────────────────
CREATE TABLE IF NOT EXISTS download_queue (
  id           TEXT    PRIMARY KEY,
  asset_type   TEXT    NOT NULL,   -- 'image' | 'mysoku'
  property_id  TEXT    NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source_url   TEXT    NOT NULL,
  r2_key       TEXT,               -- 保存先R2キー (処理後セット)
  status       TEXT    NOT NULL DEFAULT 'pending',
    -- pending | processing | done | failed | skipped
  retry_count  INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  file_size_bytes INTEGER,
  content_type TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  UNIQUE(property_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_dq_status       ON download_queue(status, retry_count);
CREATE INDEX IF NOT EXISTS idx_dq_property     ON download_queue(property_id);
CREATE INDEX IF NOT EXISTS idx_dq_created      ON download_queue(created_at);

-- ── CSVインポート履歴 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS csv_imports (
  id            TEXT    PRIMARY KEY,
  filename      TEXT    NOT NULL,
  source        TEXT    DEFAULT 'manual',  -- 'manual' | 'scheduled'
  total_rows    INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  updated_rows  INTEGER NOT NULL DEFAULT 0,
  skipped_rows  INTEGER NOT NULL DEFAULT 0,
  error_rows    INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'pending',
    -- pending | processing | completed | failed
  imported_by   TEXT,
  error_log     TEXT,
  imported_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

-- ── 成約事例テーブル補完インデックス ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_txn_prefecture_type
  ON transaction_records(prefecture, property_type);
CREATE INDEX IF NOT EXISTS idx_txn_price
  ON transaction_records(sold_price);

-- ── 検索ログ 古いデータ自動削除用インデックス ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_search_logs_created
  ON search_logs(created_at);
