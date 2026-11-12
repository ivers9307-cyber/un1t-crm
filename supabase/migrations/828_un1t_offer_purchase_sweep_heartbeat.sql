-- 828 — BLACKFRIDAY.6: heartbeat row for the offer purchase sweep.
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS (CLAUDE.md cron rule:
--   stampHeartbeat() is UPDATE-only, and a row seeded early goes stale).
--
-- sweepUn1tOfferPurchases (src/lib/un1t-offer-purchases.js) is an arm of the
-- */15 Vercel cron /api/cron/un1t-online-sync, placed after the €39 purchase
-- arm. The route stamps 'un1t-offer-purchase-sweep' only when every studio's
-- sweep returned ok (no timeout, no throw); failed / passwordPending are counts
-- in last_outcome, not faults. A run with no eligible studio is clean and stamps.
--
-- Cadence: 900s interval (the parent's */15), 1800s grace, so STALE 45 minutes
-- after the last clean run (same sizing as mig 805). Born healthy
-- (last_ok_at = now()); a replay re-arms it. Tune the grace in a new migration.
--
-- grant: none (no new relation)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'un1t-offer-purchase-sweep',
  now(),
  900,
  1800,
  'BLACKFRIDAY.6 — the offer purchase arm (src/lib/un1t-offer-purchases.js sweepUn1tOfferPurchases) of the */15 Vercel cron /api/cron/un1t-online-sync. No route or vercel.json entry of its own. Records each studio''s recent offer purchases and matches them to offer pages. Stamped ONLY when every studio''s sweep returned ok (judged on ok alone); zero eligible studios is clean and stamps. Independent of the parent and of the welcome and €39 purchase sweeps. STALE = no clean sweep for 45 minutes: read the un1t-online-sync logError lines. last_outcome carries { locations, checked, recorded, matchedPage, expired, failed, passwordPending }.'
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
   WHERE h.name = 'un1t-offer-purchase-sweep'
     AND h.expected_interval_seconds = 900
     AND h.grace_seconds = 1800;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 828: cron_heartbeats row un1t-offer-purchase-sweep did not end up on expected_interval_seconds 900 + grace_seconds 1800; nothing was applied';
  END IF;
END $$;
