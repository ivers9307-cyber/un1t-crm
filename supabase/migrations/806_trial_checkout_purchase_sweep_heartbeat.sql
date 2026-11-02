-- 806 — STILL39SEQ.1: heartbeat row for the checkout €39 purchase sweep.
--
-- sweepCheckoutTrialPurchases (src/lib/trial-checkout-purchase-sweep.js) is an
-- arm of the */2 Vercel cron /api/cron/process-trial-purchases. The route
-- stamps 'trial-checkout-purchase-sweep' only when the sweep returned ok (no
-- failed read, no refused enrolment, no throw); a run with no active
-- paid_trial_checkout_purchased sequence anywhere, or no purchase to offer, is
-- clean and stamps. stampHeartbeat() is UPDATE-only:
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS.
--
-- Cadence: 120s interval (the parent's */2), 600s grace, so STALE 12 minutes
-- after the last clean run: four missed ticks never page, six do. Born healthy
-- (last_ok_at = now()); a replay re-arms it (last_outcome is left alone). Tune
-- the grace in a new migration.
--
-- grant: none (no new relation)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'trial-checkout-purchase-sweep',
  now(),
  120,
  600,
  'STILL39SEQ.1 — the checkout €39 purchase enrolment arm (src/lib/trial-checkout-purchase-sweep.js sweepCheckoutTrialPurchases) of the */2 Vercel cron /api/cron/process-trial-purchases. No route or vercel.json entry of its own. Offers each paid, granted, linked trial_purchases row of the last 48 hours (the CRM /trial checkout: Stillorgan) to the studio''s active paid_trial_checkout_purchased sequences (enrolment is once per person per sequence, so a refusal is retried next tick). Stamped ONLY when the sweep returned ok; no active sequence, or nothing to offer, is clean and stamps. Independent of the parent row. STALE = no clean sweep for 12 minutes: read the trial-checkout-purchase-sweep / process-trial-purchases logError lines. last_outcome carries { locations, checked, enrolled, already, failed }.'
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
   WHERE h.name = 'trial-checkout-purchase-sweep'
     AND h.expected_interval_seconds = 120
     AND h.grace_seconds = 600;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 806: cron_heartbeats row trial-checkout-purchase-sweep did not end up on expected_interval_seconds 120 + grace_seconds 600; nothing was applied';
  END IF;
END $$;
