-- 633 — HEARTBEAT.1: heartbeat rows of their own for the shift-reminder arm
-- and the roster-runway arm.
--
-- WHY
-- ───
-- Both arms ride another cron's schedule and, until now, its heartbeat row:
--
--   * SHIFTREMIND.1 (#1730): runShiftReminders (src/lib/shift-reminders.js)
--     is the shift arm of the */5 Vercel cron /api/cron/send-push-reminders.
--     A throw is caught, reported as shift_arm_failed: 1 in the response, and
--     'send-push-reminders' is stamped anyway (with no outcome at all).
--   * RUNWAY.1 (#1734): runRosterRunwayAlerts (src/lib/roster-runway-notify.js)
--     is the first arm of the daily 08:00 UTC cron /api/cron/contract-reminders.
--     A throw is caught, written into 'contract-reminders'.last_outcome.runway,
--     and that row is stamped anyway.
--
-- /api/cron/health-check reads only cron_health.is_stale (mig 053), never
-- last_outcome, so either arm failing on EVERY run paged nobody. Same class as
-- the swap cover arm (SWAPHB.1, mig 623) and the 24-day silent enrolment
-- outage (#1685).
--
-- The routes now stamp these rows ONLY when the arm returned an outcome with
-- no fault of its own (src/lib/cron-arm-health.js). A run with nothing to send
-- is healthy and stamps: a quiet day, a quiet-hours tick, no locations.
-- stampHeartbeat() is UPDATE-only, so without these rows the new stamps are
-- logged no-ops:
--
--   APPLY THIS MIGRATION BEFORE THE CODE DEPLOYS.
--
-- The health-check needs no change: cron_health is an unfiltered SELECT over
-- cron_heartbeats, so a row is monitored the moment it exists.
--
-- CADENCE
-- ───────
-- shift-reminders: 300s interval (the parent's */5), 900s grace, so STALE 20
--   minutes after the last clean run. NOT the parent's 600 (mig 171): this
--   stamp is conditional, and after two transient bad ticks the next good one
--   lands at +15 min, exactly on a 300+600 boundary (SWAPHB.1's reasoning).
--   Two bad ticks never page; four in a row always do. The arm's quiet hours
--   (22:00-07:00) return normally and stamp, so the row does not go stale
--   overnight.
-- roster-runway: 86400s interval, 43200s grace: the daily convention of the
--   parent row (mig 445) and extend-roster-horizon (mig 601), "a missed day
--   plus half a day". The cron is 08:00 UTC all year (09:00 Dublin in summer,
--   08:00 in winter), so DST never moves the interval. One failed daily run
--   pages around 20:00 UTC that day; its next retry is 24 hours away.
--
-- BORN HEALTHY, ON CONFLICT DO UPDATE (RE-ARM), LIKE 601/623
-- ──────────────────────────────────────────────────────────
-- last_ok_at = now() so neither row can page before its first real stamp. That
-- is 20 minutes for shift-reminders. If the deploy is held up longer, re-run
-- this file: a replay re-arms last_ok_at and rewrites the schedule and notes
-- to the values below (last_outcome is left alone). The trade-off, accepted
-- as in 601/623: a replay also resets a row that had genuinely gone stale (it
-- pages again one window later if the arm is still broken) and undoes a
-- hand-tuned grace. Tune the grace in a new migration, not by hand.
--
-- The self-check at the bottom reads the POST-state: both rows must END UP on
-- exactly the schedule the routes and the comments above rely on, or the
-- whole file aborts (nothing is applied). It pins the VALUES list to the
-- intended numbers, so an edit to one without the other cannot apply, and it
-- refuses anything outside the INSERT (a trigger, a rule) that bends the row.

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES
  (
    'shift-reminders',
    now(),
    300,
    900,
    'HEARTBEAT.1 — the shift arm (src/lib/shift-reminders.js runShiftReminders, SHIFTREMIND.1) of the */5 Vercel cron /api/cron/send-push-reminders. No route or vercel.json entry of its own. Stamped ONLY when the arm returned a summary with shift_claim_failed, shift_send_threw and shift_read_capped all 0 (src/lib/cron-arm-health.js); a failed delivery (shift_send_failed, claim released, retried next tick) still stamps. Independent of the parent: a failing shift arm still stamps send-push-reminders. Quiet-hours ticks (22:00-07:00 studio time) stamp. STALE = the arm has thrown or reported a fault on every tick for 20 minutes: read this row''s last_outcome and the shift-reminders / cron-push-reminders logError lines. last_outcome carries the arm''s counters { quiet_hours, shift_candidates, shift_pushed, shift_emailed, shift_skipped_dup, shift_skipped_no_recipient, shift_send_failed, shift_send_threw, shift_claim_failed, shift_read_capped }.'
  ),
  (
    'roster-runway',
    now(),
    86400,
    43200,
    'HEARTBEAT.1 — the roster-runway arm (src/lib/roster-runway-notify.js runRosterRunwayAlerts, RUNWAY.1) of the daily 08:00 UTC Vercel cron /api/cron/contract-reminders. No route or vercel.json entry of its own. Stamped right after the arm, before the contract half runs, ONLY when it returned an outcome and did not throw (a locations or runway read failure); a per-recipient delivery failure (outcome.failed, claim released for the next day) still stamps. Independent of the parent: a failing runway arm still stamps contract-reminders, and a crashing contract half does not cost this row its stamp. STALE = no clean run for 36 hours: read contract-reminders.last_outcome.runway (the error text) and the cron-contract-reminders logError lines. last_outcome carries { locations, alerts, quiet_hours, sent, emailed, deduped, failed }.'
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
  FOR e IN SELECT * FROM (VALUES ('shift-reminders', 300, 900), ('roster-runway', 86400, 43200)) AS v(name, interval_s, grace_s) LOOP
    PERFORM 1 FROM public.cron_heartbeats h
     WHERE h.name = e.name
       AND h.expected_interval_seconds = e.interval_s
       AND h.grace_seconds = e.grace_s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 633: cron_heartbeats row % did not end up on expected_interval_seconds % + grace_seconds % (the VALUES above and this check disagree, or something outside the INSERT rewrote the row); nothing was applied', e.name, e.interval_s, e.grace_s;
    END IF;
  END LOOP;
END $$;
