-- 553 — per-event comms location. The real UN1T location whose Twilio + email
-- identity an event's outbound comms (confirmation/payment SMS, confirmation/
-- reminder email) use. NULL is resolved at send time by resolveEventCommsLocation
-- (host event -> org master_location_id -> anchor; normal event -> location_id),
-- so no backfill is needed. ON DELETE SET NULL falls back to that resolver.
ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS sending_location_id uuid NULL
    REFERENCES public.locations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.race_events.sending_location_id IS
  'EVENT-COMMS-LOC (mig 553) — real UN1T location whose Twilio + email identity this event''s outbound comms use. NULL -> resolved at send time (host event -> org master_location_id -> anchor; normal event -> location_id).';
