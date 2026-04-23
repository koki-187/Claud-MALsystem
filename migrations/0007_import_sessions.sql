-- Migration 0007: import_sessions — TERASS の delisted 検知用セッション管理
-- 1セッション = 1日の TERASS フルインポート (6 カテゴリ)
-- session 完了後に「このセッションで触れなかった active 物件」を delisted にマークする
-- ただし hit_export_limit=true (10,000 行打ち切り) のカテゴリは対象外

CREATE TABLE IF NOT EXISTS import_sessions (
  id TEXT PRIMARY KEY,                                    -- UUID
  source TEXT NOT NULL,                                   -- 'terass' 等
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',             -- 'in_progress' / 'completed' / 'failed' / 'aborted'
  categories_json TEXT,                                   -- {"mansion_active":{"rowCount":9999,"hitLimit":true}, ...}
  total_imported INTEGER DEFAULT 0,
  total_marked_delisted INTEGER DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_sessions_source_started ON import_sessions(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_sessions_status ON import_sessions(status);

-- properties に最終インポートセッションIDを追記 (last_seen_at と並列)
-- ALTER TABLE ADD COLUMN は IF NOT EXISTS 非対応 — 二重実行は無視される
ALTER TABLE properties ADD COLUMN import_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_properties_import_session ON properties(import_session_id);
