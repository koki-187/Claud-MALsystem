-- Migration 0008: パフォーマンス強化 + FTS5全文検索 + 掲載落ち検知
-- Apply: wrangler d1 execute mal-search-db --remote --file=migrations/0008_perf_fts5.sql
-- 注意: FTS5初期データ投入は POST /api/admin/rebuild-fts を別途実行すること

-- ─── FTS5 仮想テーブル (全文検索) ─────────────────────────────────────────────
-- content= で properties テーブルの行を参照 (コンテンツの二重保存を回避)
CREATE VIRTUAL TABLE IF NOT EXISTS properties_fts USING fts5(
  title,
  address,
  city,
  station,
  description,
  content=properties,
  content_rowid=rowid,
  tokenize='unicode61'
);

-- FTS5 同期トリガー (INSERT/UPDATE/DELETE に追従)
CREATE TRIGGER IF NOT EXISTS properties_fts_ai
  AFTER INSERT ON properties BEGIN
    INSERT INTO properties_fts(rowid, title, address, city, station, description)
    VALUES (
      new.rowid,
      COALESCE(new.title, ''),
      COALESCE(new.address, ''),
      COALESCE(new.city, ''),
      COALESCE(new.station, ''),
      COALESCE(new.description, '')
    );
  END;

CREATE TRIGGER IF NOT EXISTS properties_fts_ad
  AFTER DELETE ON properties BEGIN
    INSERT INTO properties_fts(properties_fts, rowid, title, address, city, station, description)
    VALUES (
      'delete', old.rowid,
      COALESCE(old.title, ''),
      COALESCE(old.address, ''),
      COALESCE(old.city, ''),
      COALESCE(old.station, ''),
      COALESCE(old.description, '')
    );
  END;

CREATE TRIGGER IF NOT EXISTS properties_fts_au
  AFTER UPDATE ON properties BEGIN
    INSERT INTO properties_fts(properties_fts, rowid, title, address, city, station, description)
    VALUES (
      'delete', old.rowid,
      COALESCE(old.title, ''),
      COALESCE(old.address, ''),
      COALESCE(old.city, ''),
      COALESCE(old.station, ''),
      COALESCE(old.description, '')
    );
    INSERT INTO properties_fts(rowid, title, address, city, station, description)
    VALUES (
      new.rowid,
      COALESCE(new.title, ''),
      COALESCE(new.address, ''),
      COALESCE(new.city, ''),
      COALESCE(new.station, ''),
      COALESCE(new.description, '')
    );
  END;

-- ─── 複合インデックス (最頻クエリパターン対応) ────────────────────────────────
-- メイン検索: status='active' AND prefecture=? AND is_dedup_primary=1 ORDER BY scraped_at DESC
CREATE INDEX IF NOT EXISTS idx_prop_main_search
  ON properties(status, prefecture, is_dedup_primary, scraped_at DESC);

-- 価格ソート: ORDER BY price ASC/DESC
CREATE INDEX IF NOT EXISTS idx_prop_price_sort
  ON properties(status, prefecture, is_dedup_primary, price);

-- 面積ソート: ORDER BY area ASC/DESC
CREATE INDEX IF NOT EXISTS idx_prop_area_sort
  ON properties(status, prefecture, is_dedup_primary, area);

-- 利回りソート: ORDER BY yield_rate DESC
CREATE INDEX IF NOT EXISTS idx_prop_yield_sort
  ON properties(status, is_dedup_primary, yield_rate DESC)
  WHERE yield_rate IS NOT NULL;

-- サイト別 + 都道府県 (管理画面統計クエリ高速化)
CREATE INDEX IF NOT EXISTS idx_prop_site_pref
  ON properties(site_id, prefecture, status);

-- ─── 掲載落ち検知用インデックス ──────────────────────────────────────────────
-- WHERE status='active' AND last_seen_at < datetime('now', '-30 days')
CREATE INDEX IF NOT EXISTS idx_prop_last_seen
  ON properties(status, last_seen_at)
  WHERE status = 'active';

-- ─── master_properties 検索用インデックス ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_master_search_main
  ON master_properties(prefecture, internal_status, last_seen_at DESC)
  WHERE internal_status != 'sold';

CREATE INDEX IF NOT EXISTS idx_master_price_sort
  ON master_properties(prefecture, internal_status, price)
  WHERE internal_status != 'sold';

-- ─── suggest API 高速化 ───────────────────────────────────────────────────────
-- city + station をまとめて LIKE 検索するためのインデックス
CREATE INDEX IF NOT EXISTS idx_prop_city_suggest
  ON properties(city, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_prop_station_suggest
  ON properties(station, status)
  WHERE status = 'active' AND station IS NOT NULL;
