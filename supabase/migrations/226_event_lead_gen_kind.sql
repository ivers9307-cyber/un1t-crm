-- 226: Lead Gen event kind (EVENTS-LEADGEN)
--
-- A 'lead_gen' event is a pure data-capture signup form: name, email,
-- phone — no date, no time, no waves, no payment. Each public signup
-- creates a confirmed 1-person registration (so it shows in the
-- event's roster + count) AND a tagged contact dropped straight into
-- the sales funnel (per-event slug tag + a generic 'lead_gen' tag).
--
-- Two schema changes make this fit the existing race_events shape:
--   1. Add 'lead_gen' to the kind CHECK.
--   2. race_date becomes nullable — lead_gen events have no date. All
--      existing kinds still send a date (enforced in the API layer).
ALTER TABLE race_events DROP CONSTRAINT IF EXISTS race_events_kind_check;
ALTER TABLE race_events ADD CONSTRAINT race_events_kind_check
  CHECK (kind = ANY (ARRAY['race','workshop','seminar','open_day','masterclass','lead_gen']));

ALTER TABLE race_events ALTER COLUMN race_date DROP NOT NULL;
