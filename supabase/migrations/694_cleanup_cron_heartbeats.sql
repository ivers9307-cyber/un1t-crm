-- 694 — CLEANUP-1: heartbeat rows for the two retention crons approved by
-- Richard on 1 Oct 2026 (both destructive, both approved).
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CLEANUP-1 CODE DEPLOYS (or re-run it
--   then). Each row is born healthy (last_ok_at = now()) and goes STALE 36
--   hours later unless the deployed route has stamped it, so a row seeded long
--   before the deploy pages. Before the deploy nothing stamps it; after the
--   deploy, until it exists, the route's stamp is a logged no-op
--   (stampHeartbeat is UPDATE-only), which costs nothing.
--
--   This file deletes NOTHING. The deletes happen in the routes, on their
--   first scheduled run after the deploy.
--
-- THE TWO CRONS
-- ─────────────
-- purge-glofox-webhook-events — /api/cron/purge-glofox-webhook-events, daily
--   04:05 UTC (C47 GLOFOXEVENTRETENTION.1). Deletes glofox_webhook_events rows
--   with no activity for 90 days (received_at AND processed_at, or a NULL
--   processed_at, before the cutoff), keeping any row with a
--   glofox_webhook_attempts row processed inside the window (the delete
--   cascades into attempts, mig 649). At most 1,000 rows a run, 200 per
--   DELETE. Prod on 2 Oct: 5,830 of 16,298 rows qualify, so the backlog
--   drains over about six runs.
--
-- sweep-car-document-orphans — /api/cron/sweep-car-document-orphans, daily
--   04:25 UTC (C130 CARDOCORPHANS.1). Removes car-documents objects whose path
--   is a signed-upload slot (`<car uuid>/<doc_type>/<uuid>.<ext>`), older than
--   24 hours and named by no car_documents.storage_path (nor an invoices_queue
--   car-documents attachment). Never `cars/` or any other shape. At most 500
--   a run. Prod on 2 Oct: 15 objects, 0 match the slot shape.
--
-- Both stamp only on a clean run (nothing to do and a capped run included); a
-- failed read or delete answers 500 and does not stamp, so a purge that has
-- stopped purging pages.
--
-- CADENCE
-- ───────
-- 86400s interval, 43200s grace, as mig 587's purge-webhook-payloads: one
-- missed day plus half a day before it pages, so a single missed tick never
-- does. The health-check needs no change: cron_health is an unfiltered
-- SELECT over cron_heartbeats.
--
-- ON CONFLICT DO UPDATE (RE-ARM), like 587/642: a replay re-arms last_ok_at
-- and rewrites the schedule and notes; last_outcome is left alone. The
-- self-check reads the POST-state and aborts the whole file if a row did not
-- end up on exactly this schedule.
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here):
--   DELETE FROM public.cron_heartbeats
--    WHERE name IN ('purge-glofox-webhook-events', 'sweep-car-document-orphans');
--   (and remove the two vercel.json entries, or the routes keep running).

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES
  (
    'purge-glofox-webhook-events',
    now(),
    86400,
    43200,
    'C47 GLOFOXEVENTRETENTION.1 (CLEANUP-1, mig 694) — /api/cron/purge-glofox-webhook-events, daily 04:05 UTC. Deletes glofox_webhook_events rows with no activity for 90 days (received_at and processed_at, or a NULL processed_at, before the cutoff); a row with a glofox_webhook_attempts row processed inside the window is kept (the delete cascades into attempts). At most 1,000 rows a run, 200 per DELETE, oldest first. Stamps on a clean run (idle or capped included); a failed read or delete answers 500 and does not stamp. last_outcome: { cutoff, deleted, pages, kept_recent_attempts, cap_reached }.'
  ),
  (
    'sweep-car-document-orphans',
    now(),
    86400,
    43200,
    'C130 CARDOCORPHANS.1 (CLEANUP-1, mig 694) — /api/cron/sweep-car-document-orphans, daily 04:25 UTC. Removes car-documents objects whose path is a signed-upload slot (<car uuid>/<doc_type>/<uuid>.<ext>), older than 24 h and named by no car_documents.storage_path or invoices_queue car-documents attachment_path. Never cars/ (Xero invoice PDFs) or any other shape. At most 500 a run, 100 per remove. Stamps on a clean run (idle or capped included); a failed list, reference read or remove answers 500 and does not stamp. last_outcome carries counts only.'
  )
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- Self-check (POST-state): both rows exist on exactly the intended schedule.
-- Anything else aborts the whole file, so nothing above is applied.
DO $$
DECLARE
  e record;
BEGIN
  FOR e IN SELECT * FROM (VALUES
    ('purge-glofox-webhook-events', 86400, 43200),
    ('sweep-car-document-orphans', 86400, 43200)
  ) AS v(name, interval_s, grace_s) LOOP
    PERFORM 1 FROM public.cron_heartbeats h
     WHERE h.name = e.name
       AND h.expected_interval_seconds = e.interval_s
       AND h.grace_seconds = e.grace_s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 694: cron_heartbeats row % did not end up on expected_interval_seconds % + grace_seconds %; nothing was applied', e.name, e.interval_s, e.grace_s;
    END IF;
  END LOOP;
END $$;
