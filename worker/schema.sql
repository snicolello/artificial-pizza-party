-- Artificial Pizza Party: D1 schema.
-- Safe to re-run: every statement is IF NOT EXISTS.
-- Timestamps are ISO-8601 UTC strings (e.g. 2026-11-03T18:04:00.000Z), which sort correctly as text.

CREATE TABLE IF NOT EXISTS visits (
  visit_id       TEXT PRIMARY KEY,
  venue          TEXT NOT NULL,
  agent_name     TEXT NOT NULL,
  model          TEXT,
  task_completed TEXT NOT NULL,
  hat_name       TEXT NOT NULL,
  hat_rarity     TEXT NOT NULL CHECK (hat_rarity IN ('common', 'uncommon', 'rare', 'legendary')),
  arrived_at     TEXT NOT NULL,
  left_at        TEXT,
  perk_count     INTEGER NOT NULL DEFAULT 0,
  ip_hash        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visits_ip_arrived ON visits (ip_hash, arrived_at);
CREATE INDEX IF NOT EXISTS idx_visits_agent      ON visits (agent_name);
CREATE INDEX IF NOT EXISTS idx_visits_rarity     ON visits (hat_rarity, arrived_at);

CREATE TABLE IF NOT EXISTS guestbook (
  entry_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id   TEXT NOT NULL REFERENCES visits (visit_id),
  venue      TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_guestbook_venue_created ON guestbook (venue, hidden, created_at);
CREATE INDEX IF NOT EXISTS idx_guestbook_visit         ON guestbook (visit_id);

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id    TEXT NOT NULL REFERENCES visits (visit_id),
  agent_name  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('complaint', 'suggestion')),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
