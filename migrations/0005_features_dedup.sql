-- Migration 0005: property_features 正式化 + dedup primary 列
-- Apply: wrangler d1 execute mal-search-db --remote --file=migrations/0005_features_dedup.sql

CREATE TABLE IF NOT EXISTS property_features (
  property_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  PRIMARY KEY (property_id, feature),
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_property_features_property ON property_features(property_id);

-- dedup primary boolean: fingerprint毎の代表行のみ 1
ALTER TABLE properties ADD COLUMN is_dedup_primary INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_properties_dedup_pri ON properties(is_dedup_primary, prefecture, status);

-- 初期化: 各fingerprint groupでMIN(id)以外を 0 にする
UPDATE properties SET is_dedup_primary = 0
WHERE fingerprint IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id) FROM properties WHERE fingerprint IS NOT NULL GROUP BY fingerprint
  );
