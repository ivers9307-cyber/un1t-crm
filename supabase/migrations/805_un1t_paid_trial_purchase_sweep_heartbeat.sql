-- 805 — PAIDTRIALTRIGGER.1: heartbeat row for the €39 purchase sweep.
--
-- sweepPaidTrialPurchases (src/lib/un1t-paid-trial-purchases.js) is an arm of
-- the */15 Vercel cron /api/cron/un1t-online-sync. The route stamps
-- 'un1t-paid-trial-purchase-sweep' only when every studio's sweep finished
-- clean (no failed read, no refused enrolment, no throw, no timeout); a run
-- with no eligible studio, or a studio with no active un1t_paid_trial_purchased
-- sequence, is clean and stamps. stampHeartbeat() is UPDATE-only:
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS.
--
-- Cadence: 900s interval (the parent's */15), 1800s grace, so STALE 45 minutes
-- after the last clean run: two missed ticks never page, three do (the welcome
-- sweep's sizing, mig 791). Born healthy (last_ok_at = now()); a replay re-arms
-- it (last_outcome is left alone). Tune the grace in a new migration.
--
-- grant: none (no new relation)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'un1t-paid-trial-purchase-sweep',
  now(),
  900,
  1800,
  'PAIDTRIALTRIGGER.1 — the €39 purchase enrolment arm (src/lib/un1t-paid-trial-purchases.js sweepPaidTrialPurchases) of the */15 Vercel cron /api/cron/un1t-online-sync. No route or vercel.json entry of its own. Offers each paid, unrefunded, linked €39 purchase of the last 48 hours to the studio''s active un1t_paid_trial_purchased sequences (enrolment is once per person per sequence, so a refusal is retried next tick). Stamped ONLY when every studio''s sweep returned ok; zero eligible studios, or no active sequence, is clean and stamps. Independent of the parent and of the welcome sweep. STALE = no clean sweep for 45 minutes: read the un1t-paid-trial-purchases / un1t-online-sync logError lines. last_outcome carries { locations, checked, enrolled, already, failed }.'
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
   WHERE h.name = 'un1t-paid-trial-purchase-sweep'
     AND h.expected_interval_seconds = 900
     AND h.grace_seconds = 1800;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 805: cron_heartbeats row un1t-paid-trial-purchase-sweep did not end up on expected_interval_seconds 900 + grace_seconds 1800; nothing was applied';
  END IF;
END $$;
