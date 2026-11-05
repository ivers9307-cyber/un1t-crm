-- 812 — NEWSTART.1f: heartbeat row for the stalled Glofox promo claim sweep.
--
-- sweepStalledGlofoxCorpClaims (src/lib/corp-promo-stalled-sweep.js) is an
-- arm of the */2 Vercel cron /api/cron/process-trial-purchases. The route
-- stamps 'corp-promo-stalled-sweep' only when the sweep returned ok (no
-- failed read, no claim it could not file, no throw); a run with no stalled
-- claim is clean and stamps. stampHeartbeat() is UPDATE-only:
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
  'corp-promo-stalled-sweep',
  now(),
  120,
  600,
  'NEWSTART.1f — the stalled Glofox promo claim arm (src/lib/corp-promo-stalled-sweep.js sweepStalledGlofoxCorpClaims) of the */2 Vercel cron /api/cron/process-trial-purchases. No route or vercel.json entry of its own. Files each corp_promo_claims row of a Glofox promo (Stillorgan /newstart) still processing after 15 minutes as help_requested with reason stalled and alerts the studio''s organisation; never calls Glofox. Stamped ONLY when the sweep returned ok; no stalled claim is clean and stamps. Independent of the parent row. STALE = no clean sweep for 12 minutes: read the corp-promo-stalled-sweep / process-trial-purchases logError lines. last_outcome carries { checked, filed, failed }.'
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
   WHERE h.name = 'corp-promo-stalled-sweep'
     AND h.expected_interval_seconds = 120
     AND h.grace_seconds = 600;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 812: cron_heartbeats row corp-promo-stalled-sweep did not end up on expected_interval_seconds 120 + grace_seconds 600; nothing was applied';
  END IF;
END $$;
