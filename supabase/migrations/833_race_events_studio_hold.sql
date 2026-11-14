-- 833 — SHELLYEVENTS.2: how long an event holds its studio on, and an
-- off-site flag for a studio's own events.
--
-- Apply BEFORE the code that depends on it deploys (the Shelly and climate
-- loaders select both columns; the staff event routes write them).
--
-- studio_hold_minutes: how long the studio is kept on after the event's LAST
-- start time (src/lib/shelly/studio-events.js). NULL = duration_minutes, else
-- 120. It is its own column because duration_minutes is customer-facing (the
-- length of the calendar entry an attendee adds): holding a studio on for 3
-- hours must not tell attendees their session is 3 hours long (Richard,
-- 14 Nov 2026). Staff-only: the host form and HostEventSchema never carry it.
--
-- held_offsite: a studio's OWN event (host_id NULL, venue_location_id NULL)
-- counts as held at its own studio (mig 832). This flag is how staff say one
-- is not, so the timers and the air conditioning leave the studio alone.
--
-- No grant change: both follow race_events' existing privileges.

ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS studio_hold_minutes integer NULL
    CHECK (studio_hold_minutes IS NULL OR (studio_hold_minutes BETWEEN 15 AND 1440)),
  ADD COLUMN IF NOT EXISTS held_offsite boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.race_events.studio_hold_minutes IS
  'SHELLYEVENTS.2 (mig 833): minutes the studio is kept on after the last start time. NULL = duration_minutes, else 120. Staff-only; never customer-facing.';
COMMENT ON COLUMN public.race_events.held_offsite IS
  'SHELLYEVENTS.2 (mig 833): true = not held at any of our studios, so no studio is held on for it. Meaningful for a studio''s own events; a host event says the same with venue_location_id NULL.';
