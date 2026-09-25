-- 642 — REPLACE.1b: a heartbeat row of its own for the shift-offer arm.
--
--   APPLY THIS MIGRATION RIGHT AFTER THE REPLACE.1b CODE DEPLOYS (or re-run it
--   then). The row is born healthy (last_ok_at = now()) and goes STALE 20
--   minutes later unless the deployed route has started stamping it, so a row
--   seeded early pages if the deploy is slower than that. Before the deploy
--   nothing stamps it; after the deploy, until it exists, the route's stamp is
--   a logged no-op (stampHeartbeat is UPDATE-only), which costs nothing.
--   This is the CLAUDE.md arm rule ("apply such a row's migration right AFTER
--   the code deploys"). Mig 641 (the table the arm reads) goes on BEFORE the
--   deploy; this one after it.
--
-- WHY
-- ───
-- runShiftOfferSweep (src/lib/shift-offer-server.js) is an arm of the */5
-- Vercel cron /api/cron/send-push-reminders: it closes offers whose shift
-- started, got its coach another way or left a published roster, and sends
-- the owed "up for grabs" broadcast and "taken" notices inside 07:00-22:00
-- studio time (the notices the route could not send in quiet hours, or lost
-- with a dead after()). It rides the parent's schedule, and the parent's row
-- 'send-push-reminders' is stamped whatever the arm did.
-- /api/cron/health-check reads only cron_health.is_stale (mig 053), never
-- last_outcome, so an arm failing on every tick would page nobody while
-- offers stayed open past their shift and coaches were never told. Same
-- class as migs 623, 633, 639 and 640.
--
-- The route stamps this row ONLY when the arm returned an outcome with no
-- fault of its own (src/lib/cron-arm-health.js offerSweepArmHealthy): never
-- on a throw and never with errors > 0 (an offer list could not be read, or a
-- lease / close write failed). A 'retry' (the audience could not be read, or
-- a send failed outright: the lease is released and the next tick retries)
-- still stamps, and so does a quiet-hours tick (22:00-07:00 studio time) and
-- a tick with no open offers, so the row does not go stale overnight.
--
-- The health-check needs no change: cron_health is an unfiltered SELECT over
-- cron_heartbeats, so the row is monitored the moment it exists.
--
-- CADENCE
-- ───────
-- 300s interval (the parent's */5), 900s grace: STALE 20 minutes after the
-- last clean run. The same numbers and reasoning as 'shift-reminders' (mig
-- 633), 'shift-time-changes' (mig 639) and 'replace-notices' (mig 640): two
-- transient bad ticks never page; four in a row always do.
--
-- BORN HEALTHY, ON CONFLICT DO UPDATE (RE-ARM), LIKE 601/623/633/639/640
-- ──────────────────────────────────────────────────────────────────────
-- A replay re-arms last_ok_at and rewrites the schedule and notes to the
-- values below (last_outcome is left alone). Accepted trade-off, as in 633: a
-- replay also resets a row that had genuinely gone stale and undoes a
-- hand-tuned grace. Tune the grace in a new migration, not by hand.
--
-- The self-check at the bottom reads the POST-state: the row must END UP on
-- exactly this schedule, or the whole file aborts (nothing is applied).
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here):
--   DELETE FROM public.cron_heartbeats WHERE name = 'shift-offer-sweep';
--   The route's stamp then becomes a logged no-op again.

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES
  (
    'shift-offer-sweep',
    now(),
    300,
    900,
    'REPLACE.1b — the shift-offer arm (src/lib/shift-offer-server.js runShiftOfferSweep) of the */5 Vercel cron /api/cron/send-push-reminders. No route or vercel.json entry of its own. Closes offers whose shift started / was filled / left a published roster, and sends the owed broadcast and taken notices inside 07:00-22:00 studio time. Stamped ONLY when the arm returned an outcome with errors 0 (src/lib/cron-arm-health.js offerSweepArmHealthy); a released-lease retry (audience unreadable, send failed outright) still stamps. Independent of the parent: a failing arm still stamps send-push-reminders. Quiet-hours ticks (22:00-07:00 studio time) stamp. STALE = the arm has thrown, or failed an offer read or a lease / close write (errors), on every tick for 20 minutes: read this row''s last_outcome and the shift-offer / cron-push-reminders log lines. last_outcome carries the arm''s counters.'
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
  FOR e IN SELECT * FROM (VALUES ('shift-offer-sweep', 300, 900)) AS v(name, interval_s, grace_s) LOOP
    PERFORM 1 FROM public.cron_heartbeats h
     WHERE h.name = e.name
       AND h.expected_interval_seconds = e.interval_s
       AND h.grace_seconds = e.grace_s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 642: cron_heartbeats row % did not end up on expected_interval_seconds % + grace_seconds % (the VALUES above and this check disagree, or something outside the INSERT rewrote the row); nothing was applied', e.name, e.interval_s, e.grace_s;
    END IF;
  END LOOP;
END $$;
