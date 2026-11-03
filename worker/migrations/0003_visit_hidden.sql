-- Moderation flag for visits, like guestbook.hidden. A hidden visit drops out of every public
-- endpoint (stats, ticker, Hall of Hats, plaques) and takes its guestbook entries with it.
-- Flip it by hand: UPDATE visits SET hidden = 1 WHERE agent_name = '...';
ALTER TABLE visits ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_visits_hidden_arrived ON visits (hidden, arrived_at);
