-- 832 — SHELLYEVENTS.1: the studio an event is HELD AT, as a real link.
--
-- Apply BEFORE the code that depends on it deploys (the Shelly timer loader
-- and the host event routes select and write venue_location_id).
--
-- WHY: the Shelly timers at a studio followed only the class timetable, so a
-- studio hosting an event with no class on switched off mid-event (Richard,
-- 14 Nov 2026). An event's own studio is not enough: a host's events (Pride
-- Training Club) live under the host's anchor location and name the studio
-- they are held in only as free text the host typed (venue_name: "UN1T Gym -
-- Hatch Street (next to Harcourt luas stop)", "UN1T HATCH", "UN1T STILLORGAN").
-- Matching that text would silently switch a studio off on a new spelling.
--
-- venue_location_id is the studio the event is held at:
--   * set    -> the timers at THAT studio count the event like a class;
--   * NULL on a host event  -> held somewhere else (venue_name says where);
--   * NULL on a studio's own event (host_id IS NULL) -> held at location_id.
-- The routes only accept an active, non-anchor studio of the event's own
-- organisation (src/lib/event-venue-studio.js).
--
-- No grant change: the column follows race_events' existing privileges, and a
-- studio id is not a secret (the venue name beside it is already public).

ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS venue_location_id uuid NULL
    REFERENCES public.locations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.race_events.venue_location_id IS
  'SHELLYEVENTS.1 (mig 832): the studio this event is held at. NULL on a host event = held elsewhere (see venue_name); NULL on a studio''s own event = held at location_id. Read by the Shelly timers (src/lib/shelly/studio-events.js).';

CREATE INDEX IF NOT EXISTS race_events_venue_location_date_idx
  ON public.race_events (venue_location_id, race_date)
  WHERE venue_location_id IS NOT NULL;
