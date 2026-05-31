-- 225: shared events across locations (EVENTS-LOC.2)
--
-- A "shared" event is owned by one location but appears in EVERY
-- location's events list — e.g. a masterclass run for all studios shows
-- at Hatch Street and Stillorgan alike. Default false keeps every
-- existing event scoped strictly to its own location, which fixes the
-- cross-location leak (the operator events list was previously scoped to
-- all of a user's locations, so multi-site staff saw other studios'
-- events).
ALTER TABLE race_events
  ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;
