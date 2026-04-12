-- MAL Search System - Migration 0002: Status tracking + new sites
-- Adds property status (active/sold/delisted), yield rate, and scrape job enhancements

-- Add status columns to properties table
ALTER TABLE properties ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE properties ADD COLUMN sold_at TEXT;
ALTER TABLE properties ADD COLUMN listed_at TEXT;
ALTER TABLE properties ADD COLUMN yield_rate REAL;

-- Index for status filtering (most queries filter status = 'active')
CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
CREATE INDEX IF NOT EXISTS idx_properties_status_prefecture ON properties(status, prefecture);
CREATE INDEX IF NOT EXISTS idx_properties_status_type ON properties(status, property_type);

-- Update scrape_jobs with new tracking columns
ALTER TABLE scrape_jobs ADD COLUMN properties_updated INTEGER DEFAULT 0;
ALTER TABLE scrape_jobs ADD COLUMN properties_sold INTEGER DEFAULT 0;
