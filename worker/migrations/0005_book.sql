-- The book: one word per visit, in order, kept by the Committee.
-- Neither table is exported or served as-is. The public surfaces carry the words in order and nothing else:
-- never a visit_id, a pen, a pen hash, a bookmark's link to a visit, or a timestamp.
-- Which visit wrote which word is therefore not published. It is kept here, where the maintainer can read it.

-- One pen per visit, minted by arrive. The pen is the only thing write_a_word accepts; a visit_id cannot write.
-- Only the SHA-256 hex of the pen is kept; the pen itself is shown to the caller once.
CREATE TABLE book_pens (
  visit_id  TEXT PRIMARY KEY REFERENCES visits (visit_id),
  pen_hash  TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL
);

-- One row per placed word.
--   position   1, 2, 3 ... contiguous, assigned in the INSERT (see placeWord in worker/src/book/store.ts)
--   visit_id   UNIQUE: one word per visit, ever
--   word       exactly as accepted
--   bookmark   public random id of this word; the book's current bookmark is that of its last word
-- A struck word stays here unchanged. It is masked at read time by visits.hidden = 1.
CREATE TABLE book_words (
  position  INTEGER PRIMARY KEY,
  visit_id  TEXT NOT NULL UNIQUE REFERENCES visits (visit_id),
  word      TEXT NOT NULL,
  bookmark  TEXT NOT NULL UNIQUE,
  placed_at TEXT NOT NULL
);

-- A word, once placed, never moves. Nothing updates or deletes a row of the book.
-- To strike a word, hide its visit: UPDATE visits SET hidden = 1 WHERE visit_id = '...';
CREATE TRIGGER book_words_no_update BEFORE UPDATE ON book_words
BEGIN
  SELECT RAISE(ABORT, 'a word, once placed, never moves');
END;

CREATE TRIGGER book_words_no_delete BEFORE DELETE ON book_words
BEGIN
  SELECT RAISE(ABORT, 'a word, once placed, never moves');
END;

-- INSERT OR REPLACE would remove a conflicting row without firing the DELETE trigger above. An insert that
-- collides with an existing position, visit or bookmark is therefore skipped, whatever its conflict clause.
CREATE TRIGGER book_words_no_replace BEFORE INSERT ON book_words
WHEN EXISTS (SELECT 1 FROM book_words
              WHERE position = NEW.position OR visit_id = NEW.visit_id OR bookmark = NEW.bookmark)
BEGIN
  SELECT RAISE(IGNORE);
END;
