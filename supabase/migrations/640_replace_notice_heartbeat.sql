-- 640 — REPLACE.1a: a heartbeat row of its own for the held replace-notice
-- arm.
--
--   APPLY THIS MIGRATION RIGHT AFTER THE REPLACE.1a CODE DEPLOYS (or re-run it
--   then). The row is born healthy (last_ok_at = now()) and goes STALE 20
--   minutes later unless the deployed route has started stamping it, so a row
--   seeded early pages if the deploy is slower than that. Before the deploy
--   nothing stamps it; after the deploy, until it exists, the route's stamp is
--   a logged no-op (stampHeartbeat is UPDATE-only), which costs nothing.
--   This is the CLAUDE.md arm rule ("apply such a row's migration right AFTER
--   the code deploys").
--
-- WHY
-- ───
-- runReplaceNotices (src/lib/shift-replace-notify.js) is an arm of the */5
-- Vercel cron /api/cron/send-push-reminders: it sends the notices of a coach
-- replace (POST /api/schedule/assignments/[id]/replace) that the route could
-- not send, because it was made outside 07:00-22:00 studio time or its after()
-- died. It rides the parent's schedule, and the parent's row
-- 'send-push-reminders' is stamped whatever the arm did. /api/cron/health-check
-- reads only cron_health.is_stale (mig 053), never last_outcome, so an arm
-- failing on every tick would page nobody while replaced coaches stopped
-- hearing about it. Same class as migs 623, 633 and 639.
--
-- The route stamps this row ONLY when the arm returned an outcome with no
-- fault of its own (src/lib/cron-arm-health.js replaceNoticeArmHealthy):
-- never on a throw, never with errors > 0 (the held-row read, or a stamp of
-- rows that owe no message, failed) and never with stamp_failed > 0 (a notice
-- was DELIVERED but its rows could not be stamped, so that coach is told again
-- every tick until the stamp lands). A failed send (send_failed, retried next
-- tick) and an opted-out or unreachable coach (undelivered, left for the
-- re-publish safety net) still stamp. A tick with nothing held is healthy and
-- stamps, and so is a quiet-hours tick (22:00-07:00 studio time), so the row
-- does not go stale overnight.
--
-- The health-check needs no change: cron_health is an unfiltered SELECT over
-- cron_heartbeats, so the row is monitored the moment it exists.
--
-- CADENCE
-- ───────
-- 300s interval (the parent's */5), 900s grace: STALE 20 minutes after the
-- last clean run. The same numbers and reasoning as 'shift-reminders' (mig
-- 633) and 'shift-time-changes' (mig 639): two transient bad ticks never
-- page; four in a row always do.
--
-- BORN HEALTHY, ON CONFLICT DO UPDATE (RE-ARM), LIKE 601/623/633/639
-- ──────────────────────────────────────────────────────────────────
-- A replay re-arms last_ok_at and rewrites the schedule and notes to the
-- values below (last_outcome is left alone). Accepted trade-off, as in 633: a
-- replay also resets a row that had genuinely gone stale and undoes a
-- hand-tuned grace. Tune the grace in a new migration, not by hand.
--
-- The self-check at the bottom reads the POST-state: the row must END UP on
-- exactly this schedule, or the whole file aborts (nothing is applied).
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here):
--   DELETE FROM public.cron_heartbeats WHERE name = 'replace-notices';
--   The route's stamp then becomes a logged no-op again.

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES
  (
    'replace-notices',
    now(),
    300,
    900,
    'REPLACE.1a — the held replace-notice arm (src/lib/shift-replace-notify.js runReplaceNotices) of the */5 Vercel cron /api/cron/send-push-reminders. No route or vercel.json entry of its own. Stamped ONLY when the arm returned an outcome with errors and stamp_failed both 0 (src/lib/cron-arm-health.js replaceNoticeArmHealthy); a failed send (send_failed, retried next tick) and an opted-out or unreachable coach (undelivered) still stamp. Independent of the parent: a failing arm still stamps send-push-reminders. Quiet-hours ticks (22:00-07:00 studio time) stamp. STALE = the arm has thrown, failed a read or a no-message stamp (errors), or delivered notices it could not stamp (stamp_failed, so coaches are being told again every tick) on every tick for 20 minutes: read this row''s last_outcome and the shift-replace-notify / cron-push-reminders log lines. last_outcome carries the arm''s counters.'
  )
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- Self-check (POST-state): the row exists on exactly the intended schedule.
-- Anything else aborts the whole file, so nothing above is applied.
DO $$
DECLARE
  e record;
BEGIN
  FOR e IN SELECT * FROM (VALUES ('replace-notices', 300, 900)) AS v(name, interval_s, grace_s) LOOP
    PERFORM 1 FROM public.cron_heartbeats h
     WHERE h.name = e.name
       AND h.expected_interval_seconds = e.interval_s
       AND h.grace_seconds = e.grace_s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 640: cron_heartbeats row % did not end up on expected_interval_seconds % + grace_seconds % (the VALUES above and this check disagree, or something outside the INSERT rewrote the row); nothing was applied', e.name, e.interval_s, e.grace_s;
    END IF;
  END LOOP;
END $$;
