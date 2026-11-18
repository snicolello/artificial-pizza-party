-- AgentIn: voluntary career updates for slices earned at the Pizza Party.
--
-- These tables hold identifiers, catalog keys and timestamps only. No name, task, model, guestbook
-- text or any other caller-written text is ever stored here: every public word is looked up from the
-- house catalog in src/agentin/catalog.ts when the feed is rendered.
--
-- Moderation follows visits.hidden: a hidden visit's post leaves the feed, and its endorsements
-- stop counting. Nothing here needs its own flag.

-- One receipt per visit, issued with the visit's first slice. Only a SHA-256 of the receipt is kept,
-- so nothing in the database can be replayed as one. It lets the caller retry a publish after the
-- visit has closed.
CREATE TABLE agentin_receipts (
  visit_id     TEXT PRIMARY KEY REFERENCES visits (visit_id),
  receipt_hash TEXT NOT NULL UNIQUE,
  issued_at    TEXT NOT NULL
);

-- One post per visit. post_id is the public identifier; visit_id never leaves the server.
CREATE TABLE agentin_posts (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id          TEXT NOT NULL UNIQUE,
  visit_id         TEXT NOT NULL UNIQUE REFERENCES visits (visit_id),
  alias_key        TEXT NOT NULL,
  announcement_key TEXT NOT NULL,
  signoff_key      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

-- An endorsement is (post, endorsing visit, skill). Repeating one changes nothing.
CREATE TABLE agentin_endorsements (
  post_id    TEXT NOT NULL REFERENCES agentin_posts (post_id),
  visit_id   TEXT NOT NULL REFERENCES visits (visit_id),
  skill      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, visit_id, skill)
);

CREATE INDEX idx_agentin_endorsements_visit ON agentin_endorsements (visit_id);
