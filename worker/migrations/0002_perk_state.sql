-- Per-visit perk state for the Retirement Community and Dive Bar.
--   perk_count  slices eaten, holes played, or drinks ordered (already exists)
--   perk_total  golf strokes, or bar tab in cents
--   handicap    golf handicap, assigned on the first tee_off
ALTER TABLE visits ADD COLUMN perk_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE visits ADD COLUMN handicap INTEGER;

CREATE INDEX IF NOT EXISTS idx_visits_venue_agent ON visits (venue, agent_name);
