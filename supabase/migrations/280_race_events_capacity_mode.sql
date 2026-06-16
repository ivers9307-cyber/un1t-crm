-- 280: race_events.capacity_mode — EVENTS-CAPACITY-MODE.1
--
-- Lets an operator cap an event by TEAMS (count of confirmed
-- registrations — the historical behaviour) or by PEOPLE (sum of team
-- sizes). The capacity NUMBER stays per-wave on race_waves.capacity;
-- this column only changes what that number is measured in.
--
-- Default 'teams' so every EXISTING event keeps its current enforcement
-- byte-for-byte. New events pick a kind-aware default in the form
-- (race -> teams, workshop/seminar/etc -> people) and send it explicitly.

ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS capacity_mode TEXT NOT NULL DEFAULT 'teams';

ALTER TABLE public.race_events
  DROP CONSTRAINT IF EXISTS race_events_capacity_mode_check;
ALTER TABLE public.race_events
  ADD CONSTRAINT race_events_capacity_mode_check
  CHECK (capacity_mode IN ('teams', 'people'));

COMMENT ON COLUMN public.race_events.capacity_mode IS
  'How per-wave capacity is enforced: ''teams'' (count of confirmed registrations; default/legacy) or ''people'' (sum of team sizes). EVENTS-CAPACITY-MODE.1 (mig 280).';
