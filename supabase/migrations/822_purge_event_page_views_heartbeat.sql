-- 822 — HOSTSTATS.1: heartbeat row for the event_page_views retention arm.
--
-- runEventPageViewsPurgeArm (src/lib/event-page-views-purge.js) is an arm of
-- the daily Vercel cron /api/cron/purge-webhook-payloads (03:45 UTC). It
-- deletes event_page_views rows (mig 821) older than 180 days, page by page,
-- and stamps 'purge-event-page-views' only when its own run returned ok (an
-- idle run is clean). The parent's row says nothing about this arm, and the
-- health check reads only is_stale. stampHeartbeat() is UPDATE-only:
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS.
--
-- Cadence: 86400s interval, 43200s grace (the parent's sizing, mig 587), so
-- STALE 36 hours after the last clean run: one missed night never pages.
-- Born healthy (last_ok_at = now()); a replay re-arms it (last_outcome is
-- left alone). Tune the grace in a new migration.
--
-- grant: none (no new relation)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'purge-event-page-views',
  now(),
  86400,
  43200,
  'HOSTSTATS.1 — the event_page_views retention arm (src/lib/event-page-views-purge.js runEventPageViewsPurgeArm) of the daily Vercel cron /api/cron/purge-webhook-payloads (03:45 UTC). No route or vercel.json entry of its own. Deletes page-view rows older than 180 days, 500 ids a page, at most 20 pages a night (the backlog drains over following nights; capped=true in last_outcome when it hit the bound). Stamped ONLY when the run returned ok; an idle night is clean and stamps. Independent of the parent''s stamp. STALE = no clean run for 36 hours: read the cron.purge-event-page-views logWarn lines. last_outcome carries { deleted, pages, cutoff, capped }.'
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
   WHERE h.name = 'purge-event-page-views'
     AND h.expected_interval_seconds = 86400
     AND h.grace_seconds = 43200;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 822: cron_heartbeats row purge-event-page-views did not end up on expected_interval_seconds 86400 + grace_seconds 43200; nothing was applied';
  END IF;
END $$;
