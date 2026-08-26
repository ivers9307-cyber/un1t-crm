-- 571: PERSON-ACCT.10 — cron_heartbeats seed for
-- /api/cron/person-detect-scan.
--
-- SHIP ORDER: apply ONLY after the deploy that adds the cron. The health
-- check 503s on any stale cron_heartbeats row, so seeding this before the
-- route ships pages immediately (mirrors mig 563's shelly-reconcile note).
--
-- Daily off-peak sweep (see vercel.json: 45 3 * * *, between glofox-sync
-- 03:00 and pipeline-classify 03:30) that runs the duplicate-contact
-- detection scan for every active location and auto-links the
-- HIGH-CONFIDENCE pairs only (runDetection's existing commit:true path —
-- no new matching logic). Closes the gap where a new ClassPass shadow
-- account sat un-grouped until a human ran the manual detection scan.
--
-- expected_interval = 1 day; grace = 6h (one slow run or a brief Vercel
-- hiccup tolerated before the health check flags it stale).
--
-- The route withholds this stamp whenever ANY location's scan failed this
-- run (not only when every location failed) — a partially-broken sweep
-- must not read as healthy.
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'person-detect-scan',
  now(),
  86400,
  21600,
  'PERSON-ACCT.10 — daily duplicate-contact detection scan, all active locations. commit:true auto-links HIGH-CONFIDENCE pairs only (person-detect.js''s existing rule); medium/low candidates still queue in person_link_suggestions for manual review. Heartbeat withheld if any location failed this run.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;
