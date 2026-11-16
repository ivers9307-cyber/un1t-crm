-- 842 — STAFFPAYLINK.1: heartbeat row for the staff payment link sweep.
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS (CLAUDE.md cron rule:
--   stampHeartbeat() is UPDATE-only, and a row seeded early goes stale).
--
-- The staff payment link sweep (settle paid links, expire stale ones) is an arm
-- of the */2 Vercel cron /api/cron/process-trial-purchases, the same cron that
-- carries the offer purchase sweep (mig 828). The route stamps
-- 'staff-payment-link-sweep' only when the sweep ran and returned ok. A run
-- with nothing to settle is clean and stamps.
--
-- Cadence: 120s interval (the parent's */2), 600s grace, so STALE 12 minutes
-- after the last clean run (same sizing as mig 828). Born healthy
-- (last_ok_at = now()); a replay re-arms it. Tune the grace in a new migration.
--
-- grant: none (no new relation; the table's grants are in mig 841)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'staff-payment-link-sweep',
  now(),
  120,
  600,
  'STAFFPAYLINK.1 — the staff payment link arm of the */2 Vercel cron /api/cron/process-trial-purchases. Settles staff_payment_links rows to paid off the un1t_transactions mirror and expires stale live links. Stamped ONLY when the sweep returned ok (no throw). Zero links to settle is clean and stamps. STALE = no clean sweep for 12 minutes: read the process-trial-purchases logError lines (module paylink).'
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
   WHERE h.name = 'staff-payment-link-sweep'
     AND h.expected_interval_seconds = 120
     AND h.grace_seconds = 600;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 842: cron_heartbeats row staff-payment-link-sweep did not end up on expected_interval_seconds 120 + grace_seconds 600; nothing was applied';
  END IF;
END $$;
