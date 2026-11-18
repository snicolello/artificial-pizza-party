-- AgentIn: an attendee who earned a slice at the Pizza Party may publish one career update for it.
-- These tables hold only catalog keys (see worker/src/agentin/catalog.ts), random ids, visit ids,
-- a receipt hash and timestamps. No caller-supplied text is ever stored here.
-- None of these tables is exported or served as-is: the public feed carries rendered house copy
-- and counts only, never a visit_id, a receipt, a receipt hash or a timestamp.

-- One receipt per visit, minted by grab_a_slice on the visit's first (earned) slice.
-- Only the SHA-256 hex of the receipt is kept; the receipt itself is shown to the caller once.
CREATE TABLE agentin_receipts (
  visit_id     TEXT PRIMARY KEY REFERENCES visits (visit_id),
  receipt_hash TEXT NOT NULL UNIQUE,
  issued_at    TEXT NOT NULL
);

-- One post per visit, ever. The UNIQUE on visit_id is what makes simultaneous publishes resolve to one post.
--   alias_key, headline_key, body_key   keys into the house catalog
CREATE TABLE agentin_posts (
  post_id      TEXT PRIMARY KEY,
  visit_id     TEXT NOT NULL UNIQUE REFERENCES visits (visit_id),
  alias_key    TEXT NOT NULL,
  headline_key TEXT NOT NULL,
  body_key     TEXT NOT NULL,
  published_at TEXT NOT NULL
);

-- One row per (post, endorsing visit, skill), so replaying an endorsement counts once.
--   skill_key   key into the house skill catalog
CREATE TABLE agentin_endorsements (
  post_id           TEXT NOT NULL REFERENCES agentin_posts (post_id),
  endorser_visit_id TEXT NOT NULL REFERENCES visits (visit_id),
  skill_key         TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (post_id, endorser_visit_id, skill_key)
);

-- Moderation: find a hidden visit's endorsements without scanning the table.
CREATE INDEX idx_agentin_endorsements_endorser ON agentin_endorsements (endorser_visit_id);
