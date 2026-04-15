-- Migration 0003: マイソク・成約事例・R2アセット管理テーブル

-- ── property_images 拡張 ──────────────────────────────────────────────────────
ALTER TABLE property_images ADD COLUMN r2_key TEXT;
ALTER TABLE property_images ADD COLUMN original_url TEXT;
ALTER TABLE property_images ADD COLUMN width INTEGER;
ALTER TABLE property_images ADD COLUMN height INTEGER;
ALTER TABLE property_images ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0;
ALTER TABLE property_images ADD COLUMN download_status TEXT NOT NULL DEFAULT 'pending';
  -- pending | downloading | downloaded | failed

-- ── マイソク (物件概要書 / PDF) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_mysoku (
  id               TEXT    PRIMARY KEY,
  property_id      TEXT    NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  site_id          TEXT    NOT NULL,
  mysoku_url       TEXT    NOT NULL,           -- 元のファイルURL
  r2_key           TEXT,                       -- R2に保存後のキー (例: mysoku/suumo_abc123.pdf)
  file_type        TEXT    NOT NULL DEFAULT 'pdf',  -- pdf | jpg | png
  file_size_bytes  INTEGER,
  download_status  TEXT    NOT NULL DEFAULT 'pending',
  downloaded_at    TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, mysoku_url)
);

CREATE INDEX IF NOT EXISTS idx_mysoku_property ON property_mysoku(property_id);
CREATE INDEX IF NOT EXISTS idx_mysoku_status   ON property_mysoku(download_status);

-- ── 成約事例 (transaction_records) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transaction_records (
  id               TEXT    PRIMARY KEY,
  site_id          TEXT    NOT NULL,
  prefecture       TEXT    NOT NULL,
  city             TEXT,
  property_type    TEXT,                       -- mansion | kodate | tochi | investment
  sold_price       INTEGER,                    -- 成約価格 (万円)
  listed_price     INTEGER,                    -- 掲載価格 (万円)
  area             REAL,
  rooms            TEXT,
  age              INTEGER,
  floor            INTEGER,
  station          TEXT,
  station_minutes  INTEGER,
  sold_at          TEXT,                       -- 成約日 (YYYY-MM-DD)
  days_on_market   INTEGER,                    -- 掲載日数
  yield_rate       REAL,                       -- 収益物件の利回り
  original_property_id TEXT,                  -- 元の properties.id (あれば)
  source_url       TEXT,
  latitude         REAL,
  longitude        REAL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_txn_prefecture ON transaction_records(prefecture);
CREATE INDEX IF NOT EXISTS idx_txn_sold_at    ON transaction_records(sold_at);
CREATE INDEX IF NOT EXISTS idx_txn_site       ON transaction_records(site_id);
CREATE INDEX IF NOT EXISTS idx_txn_type       ON transaction_records(property_type);

-- ── R2アセット管理 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS r2_assets (
  r2_key           TEXT    PRIMARY KEY,
  asset_type       TEXT    NOT NULL,           -- image | mysoku | document
  related_id       TEXT    NOT NULL,           -- property_id, mysoku id, etc.
  original_url     TEXT,
  content_type     TEXT,
  file_size_bytes  INTEGER,
  width            INTEGER,
  height           INTEGER,
  uploaded_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  last_accessed    TEXT
);

CREATE INDEX IF NOT EXISTS idx_r2_related ON r2_assets(related_id);
CREATE INDEX IF NOT EXISTS idx_r2_type    ON r2_assets(asset_type);
