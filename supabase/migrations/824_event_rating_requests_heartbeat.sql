-- 824 — HOSTPAGE.2: heartbeat row for the rating-request arm.
--
-- runRatingRequests (src/lib/event-rating-requests.js) is an arm of the
-- hourly Vercel cron /api/cron/event-reminders, on its own daily slot
-- ('event-rating-requests': 09:00 on each studio's clock, riding
-- event-reminders). The morning after a HOST event it sends every confirmed
-- entry one "How was <event>?" email with a 30-day signed /event/rate link,
-- claim-before-send on event_rating_requests. The route stamps this row only
-- on a tick that took one of the arm's slots and returned an outcome with no
-- read fault and no failed claim (a quiet morning is clean). stampHeartbeat()
-- is UPDATE-only:
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS.
--
-- Cadence: 86400s interval, 21600s grace (the parent's sizing, mig 384), so
-- STALE 30 hours after the last clean run. Born healthy (last_ok_at = now());
-- a replay re-arms it (last_outcome is left alone).
--
-- grant: none (no new relation)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'event-rating-requests',
  now(),
  86400,
  21600,
  'HOSTPAGE.2 — the post-event rating request arm (src/lib/event-rating-requests.js runRatingRequests) of the hourly Vercel cron /api/cron/event-reminders, on its own 09:00 daily slot per studio clock. No route or vercel.json entry of its own. The morning after a HOST event (never a UN1T event) every confirmed entry gets one "How was <event>?" email with a 30-day signed /event/rate link; claim-before-send on event_rating_requests, one ask per entry ever; opt-outs keep the claim. Stamped ONLY on a slot tick whose outcome had no read fault and no failed claim; a morning with no host event is clean and stamps. Independent of the parent''s stamp. STALE = no clean run for 30 hours: read the event-rating-requests logError lines. last_outcome carries { events, sent, skipped, request_read_failed, claim_failed, slot }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- Self-check (POST-state): the row exists on exactly the intended schedule.
DO $$
BEGIN
  PERFORM 1 FROM public.cron_heartbeats h
   WHERE h.name = 'event-rating-requests'
     AND h.expected_interval_seconds = 86400
     AND h.grace_seconds = 21600;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 824: cron_heartbeats row event-rating-requests did not end up on expected_interval_seconds 86400 + grace_seconds 21600; nothing was applied';
  END IF;
END $$;
