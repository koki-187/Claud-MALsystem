-- MAL Search System - Initial Schema Migration
-- Version: 5.0.0

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  site_property_id TEXT NOT NULL,
  title TEXT NOT NULL,
  property_type TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT,
  price INTEGER,
  price_text TEXT,
  area REAL,
  building_area REAL,
  land_area REAL,
  rooms TEXT,
  age INTEGER,
  floor INTEGER,
  total_floors INTEGER,
  station TEXT,
  station_minutes INTEGER,
  thumbnail_url TEXT,
  detail_url TEXT NOT NULL,
  description TEXT,
  latitude REAL,
  longitude REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, site_property_id)
);

CREATE INDEX IF NOT EXISTS idx_properties_prefecture ON properties(prefecture);
CREATE INDEX IF NOT EXISTS idx_properties_site_id ON properties(site_id);
CREATE INDEX IF NOT EXISTS idx_properties_property_type ON properties(property_type);
CREATE INDEX IF NOT EXISTS idx_properties_price ON properties(price);
CREATE INDEX IF NOT EXISTS idx_properties_area ON properties(area);
CREATE INDEX IF NOT EXISTS idx_properties_scraped_at ON properties(scraped_at);

CREATE TABLE IF NOT EXISTS property_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  image_order INTEGER DEFAULT 0,
  image_type TEXT DEFAULT 'exterior',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_property_images_property_id ON property_images(property_id);

CREATE TABLE IF NOT EXISTS property_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_property_features_property_id ON property_features(property_id);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_history_property_id ON price_history(property_id);

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  properties_found INTEGER DEFAULT 0,
  properties_new INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status ON scrape_jobs(status);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_site_id ON scrape_jobs(site_id);

CREATE TABLE IF NOT EXISTS search_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT,
  prefecture TEXT,
  property_type TEXT,
  price_min INTEGER,
  price_max INTEGER,
  results_count INTEGER,
  execution_time_ms INTEGER,
  searched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_search_logs_searched_at ON search_logs(searched_at);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_session_id ON favorites(session_id);
