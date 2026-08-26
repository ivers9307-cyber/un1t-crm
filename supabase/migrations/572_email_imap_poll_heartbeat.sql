-- 572: MAILBOX-CONNECT.5.2 — cron_heartbeats seed for /api/cron/poll-imap-mailboxes.
--
-- CLAUDE.md: a new cron ships its route, its vercel.json entry, its
-- stampHeartbeat() call and its heartbeat ROW together. stampHeartbeat() is
-- UPDATE-only, so without this row the stamp matches zero rows every five
-- minutes and the health check never notices the poller going quiet — the
-- watcher would be unwatched, which is precisely the silent-no-op shape this
-- whole feature is built to avoid. The route already logs
-- "stamp matched 0 rows" once a tick until this is applied, which is the
-- reminder that it is still pending.
--
-- SHIP ORDER: apply this AFTER the deploy that adds the cron. cron_health's
-- is_stale is computed from last_ok_at, and /api/cron/health-check answers 503
-- when ANY row is stale — so seeding ahead of the route would page immediately
-- (the mig 561 / 563 lesson). The INSERT stamps last_ok_at = now() so the row
-- is born healthy and the first real tick takes over from there.
--
-- expected_interval = 300s (the vercel.json schedule), grace = 600s. Two
-- missed ticks are tolerated before it flags, which absorbs a slow sweep: a
-- tick that is draining a backlog on several mailboxes at once can genuinely
-- run into minutes (maxDuration is 300s), and a heartbeat that pages for a
-- busy tick is a heartbeat people learn to ignore.
--
-- 🔴 WHAT THIS HEARTBEAT DOES AND DOES NOT WATCH. It watches the POLLER, not
-- the mailboxes. A sweep in which every connected mailbox failed to
-- authenticate still stamps: those are operator actions (a revoked app
-- password, 2SV reset), they are recorded per mailbox on
-- email_mailbox_ingress.last_error / paused_until, and Phase 9 alerts on them
-- distinctly from an outage. Only a sweep that could not read its own mailbox
-- list withholds the stamp. Counters ride along in last_outcome
-- ({ mailboxes, ingested, skipped, failed, paused }) so ops can tell
-- "ran, nothing connected" from "ran, three mailboxes failing".
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'poll-imap-mailboxes',
  now(),
  300,
  600,
  'MAILBOX-CONNECT.5 — five-minute IMAP poll of every email_mailboxes row with ingress=''imap''. Producer, not a pipeline: it POSTs Postmark-shaped payloads at /api/webhooks/postmark-inbound and advances email_mailbox_ingress.last_uid ONLY on a 2xx. Dormant (zero imap-ingress mailboxes) until an operator connects a login; still stamps. A tenant failing auth is counted, not fatal — only a sweep that cannot read its mailbox list withholds the stamp.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;
