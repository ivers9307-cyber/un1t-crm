-- POSTMARK-DLQ.2 — correct a false operational note, and clear one orphan.
--
-- ── 1. The cron_heartbeats note has been lying since mig 409 ───────
--
-- 409_postmark_sweeper_cadence.sql wrote this onto the
-- process-postmark-webhooks heartbeat:
--
--   "QSTASH.1 sweeper — QStash push (/api/webhooks/qstash/postmark) is the
--    primary consumer; this cron sweeps publish failures / QStash outages /
--    exhausted retries at */10"
--
-- The last clause is FALSE and always was. The sweeper selects
-- `.lt('attempts', MAX_ATTEMPTS)` (src/app/api/cron/process-postmark-webhooks/
-- route.js), so a row that has exhausted its retries is precisely the row it
-- filters OUT. It could never sweep them. Until POSTMARK-DLQ.1 those rows went
-- invisible to the whole system — carrying hard bounces, spam complaints and
-- one-click unsubscribes.
--
-- This matters because heartbeat notes are read during incidents. Someone
-- checking "are exhausted rows handled?" at 2am would have read that note, been
-- told yes, and stopped looking.
--
-- Corrected to describe what the code actually does, post-DLQ.1.

UPDATE public.cron_heartbeats
   SET notes = 'QSTASH.1 sweeper — QStash push (/api/webhooks/qstash/postmark) is the primary consumer; this cron sweeps publish failures and QStash outages at */10. It does NOT sweep exhausted rows: both consumers filter .lt(attempts, MAX_ATTEMPTS), so attempts>=MAX is exactly what they skip. Since POSTMARK-DLQ.1 those rows are captured to webhook_dead_letter (provider postmark_queue, deliberately non-replayable) at the transition to exhausted, and re-driving one is an operator action. Mig 409''s original note claimed this cron picked them up; it never could.'
 WHERE name = 'process-postmark-webhooks';

-- ── 2. Clear the orphaned smoke-test message ──────────────────────
--
-- Mig 494 dropped email_conversations but deliberately left one
-- email_inbox_messages row behind: conversation_id set, ticket_id NULL, so it
-- survives but is invisible to the ticket UI. Richard asked for it cleared
-- (2026-08-07).
--
-- Identified precisely rather than by a broad predicate: it is the webhook
-- wiring smoke test — subject 'Test', ZERO-BYTE body, self-sent from
-- accounts@champfitness.ie to accounts@hatchstreetfitness.com, 2026-08-05
-- 23:32Z. Not customer correspondence.
--
-- The WHERE clause below re-asserts every one of those facts, so if the row is
-- not what this migration believes it is, NOTHING is deleted. A cleanup
-- migration must not be able to remove a real member's email because a
-- predicate was loose.

DELETE FROM public.email_inbox_messages
 WHERE id = 'c013fa59-1c44-47db-9302-f4bffba6dea9'
   AND ticket_id IS NULL
   AND conversation_id IS NOT NULL
   AND subject = 'Test'
   AND coalesce(length(text_body), 0) = 0
   AND from_email = 'accounts@champfitness.ie';
