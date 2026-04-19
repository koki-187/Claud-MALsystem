-- Migration 0006: master_properties — TERASS PICKS 流マスター物件テーブル
-- 複数媒体ソースを canonical 1レコードに統合する

CREATE TABLE IF NOT EXISTS master_properties (
  id TEXT PRIMARY KEY,                    -- 'mp_' + sha256(fingerprint).slice(0,16)
  fingerprint TEXT NOT NULL UNIQUE,
  -- ベストオブ merged fields
  title TEXT NOT NULL,
  property_type TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT,
  price INTEGER,
  area REAL,
  building_area REAL,
  land_area REAL,
  rooms TEXT,
  age INTEGER,
  floor INTEGER,
  total_floors INTEGER,
  station TEXT,
  station_minutes INTEGER,
  management_fee INTEGER,
  repair_fund INTEGER,
  direction TEXT,
  structure TEXT,
  yield_rate REAL,
  latitude REAL,
  longitude REAL,
  description TEXT,
  -- ソース集約
  source_count INTEGER NOT NULL DEFAULT 1,
  source_sites TEXT,                      -- JSON: ["terass_reins","terass_suumo"]
  primary_source_id TEXT,                 -- properties.id (代表ソース行)
  -- 画像 (best-of)
  primary_thumbnail_url TEXT,
  primary_r2_key TEXT,
  -- 内部メタ (TERASS PICKS 模倣)
  internal_status TEXT NOT NULL DEFAULT 'available',  -- available/showing/contracted/sold
  agent_id TEXT,
  internal_notes TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  -- タイミング
  first_listed_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_master_prefecture ON master_properties(prefecture);
CREATE INDEX IF NOT EXISTS idx_master_price ON master_properties(price);
CREATE INDEX IF NOT EXISTS idx_master_property_type ON master_properties(property_type);
CREATE INDEX IF NOT EXISTS idx_master_internal_status ON master_properties(internal_status);
CREATE INDEX IF NOT EXISTS idx_master_pref_status ON master_properties(prefecture, internal_status);
CREATE INDEX IF NOT EXISTS idx_master_favorite ON master_properties(favorite);

ALTER TABLE properties ADD COLUMN master_id TEXT;
CREATE INDEX IF NOT EXISTS idx_properties_master ON properties(master_id);
