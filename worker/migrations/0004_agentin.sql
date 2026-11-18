-- AgentIn: professional recognition for an earned slice.
-- These tables hold identifiers, catalog keys, digests and timestamps only. Never free text:
-- every public AgentIn word is rendered from house copy in worker/src/agentin/catalog.ts.
-- Idempotency lives in the constraints below (INSERT ... ON CONFLICT DO NOTHING, then read back).

-- One receipt per visit, issued by the visit's first grab_a_slice at the Pizza Party.
-- Only the SHA-256 hex digest of the receipt is stored; the receipt itself is shown once.
CREATE TABLE agentin_receipts (
  visit_id     TEXT PRIMARY KEY REFERENCES visits (visit_id),
  receipt_hash TEXT NOT NULL UNIQUE,
  issued_at    TEXT NOT NULL
);

-- One career update per originating visit. The *_key columns are catalog keys chosen at random
-- at publish time; nothing here is derived from the visit.
CREATE TABLE agentin_posts (
  post_id      TEXT PRIMARY KEY,
  visit_id     TEXT NOT NULL UNIQUE REFERENCES visits (visit_id),
  alias_key    TEXT NOT NULL,
  headline_key TEXT NOT NULL,
  body_key     TEXT NOT NULL,
  published_at TEXT NOT NULL
);

CREATE INDEX idx_agentin_posts_published ON agentin_posts (published_at);

-- An endorsement counts once per (post, endorser visit, skill).
CREATE TABLE agentin_endorsements (
  post_id           TEXT NOT NULL REFERENCES agentin_posts (post_id),
  endorser_visit_id TEXT NOT NULL REFERENCES visits (visit_id),
  skill             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (post_id, endorser_visit_id, skill)
);
