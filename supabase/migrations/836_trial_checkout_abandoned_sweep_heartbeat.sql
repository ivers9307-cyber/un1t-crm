-- 836 — TRIALABANDON.1: heartbeat row for the abandoned €39 checkout sweep.
--
-- sweepAbandonedTrialCheckouts (src/lib/trial-checkout-abandoned.js) is an
-- arm of the */2 Vercel cron /api/cron/process-trial-purchases. The route
-- stamps 'trial-checkout-abandoned-sweep' only when the sweep returned ok (no
-- failed read, no held person, no refused enrolment, no failed stamp or exit,
-- no throw); a run with no sequence of that trigger anywhere, or no abandoned
-- checkout to judge, is clean and stamps. stampHeartbeat() is UPDATE-only:
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS.
--
-- (Mig 835, the two columns the sweep reads, goes in BEFORE the deploy.)
--
-- Cadence: 120s interval (the parent's */2), 600s grace, so STALE 12 minutes
-- after the last clean run: four missed ticks never page, six do (mig 806's
-- sizing). Born healthy (last_ok_at = now()); a replay re-arms it
-- (last_outcome is left alone). Tune the grace in a new migration.
--
-- grant: none (no new relation)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'trial-checkout-abandoned-sweep',
  now(),
  120,
  600,
  'TRIALABANDON.1 — the abandoned €39 checkout arm (src/lib/trial-checkout-abandoned.js sweepAbandonedTrialCheckouts) of the */2 Vercel cron /api/cron/process-trial-purchases. No route or vercel.json entry of its own. Ends paid_trial_checkout_abandoned enrolments of anyone who has since paid (exit_reason trial_purchased), then offers each unpaid /trial checkout of the last 72 hours (payment_failed, expired, failed checkout_not_opened, or awaiting_payment for an hour), once, to the studio''s active sequences of that trigger and stamps trial_purchases.abandon_followup_at/_outcome (mig 835). Stamped ONLY when the sweep returned ok; no sequence, or nothing to judge, is clean and stamps. Independent of the parent row. STALE = no clean sweep for 12 minutes: read the trial-checkout-abandoned / trial-abandoned / process-trial-purchases logError lines (a person whose eligibility could not be read is held and keeps the row stale until it can). last_outcome carries { locations, candidates, checked, enrolled, not_enrolled, no_sequence, purchased, ineligible, recent, waiting, held, failed, exited, deferred }.'
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
   WHERE h.name = 'trial-checkout-abandoned-sweep'
     AND h.expected_interval_seconds = 120
     AND h.grace_seconds = 600;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 836: cron_heartbeats row trial-checkout-abandoned-sweep did not end up on expected_interval_seconds 120 + grace_seconds 600; nothing was applied';
  END IF;
END $$;
