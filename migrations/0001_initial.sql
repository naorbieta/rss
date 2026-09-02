CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  author_id TEXT NOT NULL,
  author_screen_name TEXT NOT NULL,
  author_name TEXT NOT NULL,
  quote_json TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('following', 'search')),
  source_key TEXT NOT NULL,
  collected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS posts_created_timestamp_idx
  ON posts (created_timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS posts_source_idx
  ON posts (source_kind, source_key);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)),
  last_post_timestamp INTEGER,
  last_checked_at TEXT,
  sync_marker TEXT
);

CREATE INDEX IF NOT EXISTS accounts_handle_idx
  ON accounts (handle COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS search_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_checked_at TEXT
);

CREATE INDEX IF NOT EXISTS search_queries_schedule_idx
  ON search_queries (enabled, last_checked_at, id);

CREATE TABLE IF NOT EXISTS collector_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
