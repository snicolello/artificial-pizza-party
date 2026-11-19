-- The Book: one shared book. Each visit may add exactly one word to it.
-- Neither table is exported or served as-is. The public book carries positions and words only:
-- never a visit_id, a pen, a pen hash or a timestamp. Which visit wrote which word is not published.
-- It is kept here, where the maintainer can read it.

-- One pen per visit, minted by `arrive`. The pen is the only thing `add_a_word` accepts as proof of a
-- visit; a visit_id cannot write, because visit ids are public. Only the SHA-256 hex of the pen is kept;
-- the pen itself is shown to the caller once.
CREATE TABLE book_pens (
  visit_id  TEXT PRIMARY KEY REFERENCES visits (visit_id),
  pen_hash  TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL
);

-- The book. Positions start at 1 and have no gaps; a row is never updated or deleted, so a word never moves.
--   position  PRIMARY KEY: two visits that submit for the same position cannot both land there
--   visit_id  UNIQUE: one word per visit, ever, and a retried submission counts once
--   word      as submitted, after the word rule and the community-standards filter
-- Moderation does not touch this table: hiding the visit (visits.hidden = 1) strikes its word on every
-- public surface, and the position stays.
CREATE TABLE book_words (
  position   INTEGER PRIMARY KEY CHECK (position >= 1),
  visit_id   TEXT NOT NULL UNIQUE REFERENCES visits (visit_id),
  word       TEXT NOT NULL,
  written_at TEXT NOT NULL
);
