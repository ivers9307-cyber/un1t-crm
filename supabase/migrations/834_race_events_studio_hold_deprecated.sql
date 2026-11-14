-- 834 — SHELLYEVENTS.3: race_events.studio_hold_minutes is DEPRECATED.
--
-- How long an event keeps its studio on is one setting per STUDIO, not a
-- field on each event (Richard, 14 Nov 2026): a location_automations row,
-- key 'event_hold', config { hold_minutes } (src/lib/event-hold.js), saved
-- from the Automations page. No DDL is needed for that: location_automations
-- (mig 284) already holds a free-form config per (location_id, automation_key).
--
-- The per-event column from mig 833 stays on disk, per the repo convention
-- (code stops reading and writing it; a later migration drops it), so a
-- rollback of the code needs no database action. held_offsite (also mig 833)
-- is still in use.
--
-- Safe to apply before or after the code deploys: it only changes a comment.

COMMENT ON COLUMN public.race_events.studio_hold_minutes IS
  'DEPRECATED (mig 834): no longer read or written. The hold time is per studio: location_automations key event_hold, config.hold_minutes (src/lib/event-hold.js).';
