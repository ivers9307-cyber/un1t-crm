-- 791 — UN1TWELCOME.5: heartbeat row for the un1t.online welcome sweep.
--
-- sweepUn1tWelcomes (src/lib/un1t-online-welcome.js) is an arm of the */15
-- Vercel cron /api/cron/un1t-online-sync. The route stamps 'un1t-welcome-sweep'
-- only when every studio's sweep finished clean (no failed read or stamp, no
-- throw, no timeout); a run with no eligible studio, or a studio with no active
-- welcome sequence, is clean and stamps. stampHeartbeat() is UPDATE-only:
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS.
--
-- Cadence: 900s interval (the parent's */15), 1800s grace, so STALE 45 minutes
-- after the last clean run: two missed ticks never page, three do. Born healthy
-- (last_ok_at = now()); a replay re-arms it (last_outcome is left alone), as in
-- migs 601/623/633. Tune the grace in a new migration, not by hand.

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'un1t-welcome-sweep',
  now(),
  900,
  1800,
  'UN1TWELCOME.5 — the welcome-email enrolment arm (src/lib/un1t-online-welcome.js sweepUn1tWelcomes) of the */15 Vercel cron /api/cron/un1t-online-sync. No route or vercel.json entry of its own. Stamped ONLY when every studio''s sweep returned ok (no failed read or stamp, no throw, no timeout); zero eligible studios, or a studio with no active un1t_account_created sequence, is clean and stamps. A refused enrolment is counted as failed: under 48 h old the client is left unstamped and retried next tick, at 48 h or older it is stamped and not retried. Independent of the parent: a failing sweep still stamps un1t-online-sync. STALE = no clean sweep for 45 minutes: read the un1t-welcome / un1t-online-sync logError lines. last_outcome carries { locations, checked, enrolled, crm_made, waiting, no_contact, no_email, failed }.'
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
   WHERE h.name = 'un1t-welcome-sweep'
     AND h.expected_interval_seconds = 900
     AND h.grace_seconds = 1800;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 791: cron_heartbeats row un1t-welcome-sweep did not end up on expected_interval_seconds 900 + grace_seconds 1800; nothing was applied';
  END IF;
END $$;
