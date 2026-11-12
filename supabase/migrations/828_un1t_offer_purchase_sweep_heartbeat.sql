-- 828 — BLACKFRIDAY.6: heartbeat row for the offer purchase sweep.
--
--   APPLY THIS MIGRATION RIGHT AFTER THE CODE DEPLOYS (CLAUDE.md cron rule:
--   stampHeartbeat() is UPDATE-only, and a row seeded early goes stale).
--
-- sweepUn1tOfferPurchases (src/lib/un1t-offer-purchases.js) is an arm of the
-- */2 Vercel cron /api/cron/process-trial-purchases, placed last, after the
-- stalled claim arm (BLACKFRIDAY.9f moved it there from un1t-online-sync: its
-- set-password step is a un1t.online write, and the sync is write-fenced). The
-- route stamps 'un1t-offer-purchase-sweep' only when the un1t.online studio
-- list was read and every studio's sweep returned ok (no throw); failed /
-- passwordPending are counts in last_outcome, not faults. A run with no
-- eligible studio is clean and stamps.
--
-- Cadence: 120s interval (the parent's */2), 600s grace, so STALE 12 minutes
-- after the last clean run (same sizing as mig 806, the same cron). Born
-- healthy (last_ok_at = now()); a replay re-arms it. Tune the grace in a new
-- migration.
--
-- grant: none (no new relation)

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'un1t-offer-purchase-sweep',
  now(),
  120,
  600,
  'BLACKFRIDAY.6 — the offer purchase arm (src/lib/un1t-offer-purchases.js sweepUn1tOfferPurchases) of the */2 Vercel cron /api/cron/process-trial-purchases (moved from un1t-online-sync by BLACKFRIDAY.9f). No route or vercel.json entry of its own. Records each un1t.online studio''s recent offer purchases and matches them to offer pages. Stamped ONLY when the studio list was read and every studio''s sweep returned ok (judged on ok alone); zero eligible studios is clean and stamps. Independent of the parent and of the checkout and stalled claim sweeps. STALE = no clean sweep for 12 minutes: read the process-trial-purchases logError lines. last_outcome carries { locations, checked, recorded, matchedPage, expired, failed, passwordPending }.'
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
     AND h.expected_interval_seconds = 120
     AND h.grace_seconds = 600;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 828: cron_heartbeats row un1t-offer-purchase-sweep did not end up on expected_interval_seconds 120 + grace_seconds 600; nothing was applied';
  END IF;
END $$;
