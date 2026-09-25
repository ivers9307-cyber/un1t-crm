-- 639 — BLOCKEDIT.1: a heartbeat row of its own for the shift time-change
-- notice arm.
--
--   APPLY THIS MIGRATION AFTER THE BLOCKEDIT.1 CODE DEPLOYS (or re-run it
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
-- runShiftTimeChangeNotices (src/lib/block-edit-notify.js) is an arm of the
-- */5 Vercel cron /api/cron/send-push-reminders: it tells coaches that a
-- manager moved their published shift (PUT /api/schedule/blocks/[id]). It
-- rides the parent's schedule, and the parent's row 'send-push-reminders' is
-- stamped whatever the arm did. /api/cron/health-check reads only
-- cron_health.is_stale (mig 053), never last_outcome, so an arm failing on
-- every tick (a select 400, say) would page nobody while coaches stopped
-- hearing about moved shifts. Same class as migs 623 and 633.
--
-- The route stamps this row ONLY when the arm returned a summary with no
-- fault of its own (src/lib/cron-arm-health.js timeChangeArmHealthy): never
-- on a throw, a failed read (time_change_read_failed), a capped read
-- (time_change_read_capped) or a failed 'not_needed' stamp
-- (time_change_stamp_failed). A tick with nothing to send is healthy and
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
-- 633): two transient bad ticks never page; four in a row always do.
--
-- BORN HEALTHY, ON CONFLICT DO UPDATE (RE-ARM), LIKE 601/623/633
-- ──────────────────────────────────────────────────────────────
-- A replay re-arms last_ok_at and rewrites the schedule and notes to the
-- values below (last_outcome is left alone). Accepted trade-off, as in 633: a
-- replay also resets a row that had genuinely gone stale and undoes a
-- hand-tuned grace. Tune the grace in a new migration, not by hand.
--
-- The self-check at the bottom reads the POST-state: the row must END UP on
-- exactly this schedule, or the whole file aborts (nothing is applied).
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here):
--   DELETE FROM public.cron_heartbeats WHERE name = 'shift-time-changes';
--   The route's stamp then becomes a logged no-op again.

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES
  (
    'shift-time-changes',
    now(),
    300,
    900,
    'BLOCKEDIT.1 — the shift time-change notice arm (src/lib/block-edit-notify.js runShiftTimeChangeNotices) of the */5 Vercel cron /api/cron/send-push-reminders. No route or vercel.json entry of its own. Stamped ONLY when the arm returned a summary with time_change_read_failed, time_change_read_capped and time_change_stamp_failed all 0 (src/lib/cron-arm-health.js timeChangeArmHealthy); a failed delivery (claim released, retried next tick), a dedup, an opted-out coach and a lost post-delivery stamp still stamp. Independent of the parent: a failing arm still stamps send-push-reminders. Quiet-hours ticks (22:00-07:00 studio time) stamp. STALE = the arm has thrown or reported a fault on every tick for 20 minutes: read this row''s last_outcome and the block-edit-notify / cron-push-reminders log lines. last_outcome carries the arm''s time_change_* counters.'
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
  FOR e IN SELECT * FROM (VALUES ('shift-time-changes', 300, 900)) AS v(name, interval_s, grace_s) LOOP
    PERFORM 1 FROM public.cron_heartbeats h
     WHERE h.name = e.name
       AND h.expected_interval_seconds = e.interval_s
       AND h.grace_seconds = e.grace_s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 639: cron_heartbeats row % did not end up on expected_interval_seconds % + grace_seconds % (the VALUES above and this check disagree, or something outside the INSERT rewrote the row); nothing was applied', e.name, e.interval_s, e.grace_s;
    END IF;
  END LOOP;
END $$;
