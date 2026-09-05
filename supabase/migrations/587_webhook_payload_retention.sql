-- 587 — WEBHOOK-RETENTION.1: 90-day retention purge of FINISHED webhook
-- payload rows.
--
-- WHY
-- ───
-- webhook_dead_letter.payload (mig 315) and postmark_webhook_queue.payload
-- (mig 158) hold the raw inbound-email JSON — sender, recipients, subject,
-- body — verbatim, for replay. Nothing has ever deleted a row from either
-- table, so a contact erased under GDPR (MAIL-GDPR.1) could survive, address
-- and all, in a resolved dead letter or a processed queue row forever.
-- Richard's decision (5 Sep 2026): a 90-day RETENTION purge of finished rows,
-- not a per-row scrub. The cron is /api/cron/purge-webhook-payloads.
--
-- WHAT "FINISHED" MEANS, AND WHAT IS NEVER TOUCHED
-- ────────────────────────────────────────────────
--   webhook_dead_letter     status IN ('resolved','discarded') AND
--                           resolved_at < now() - 90 days. Every writer of
--                           those statuses (resolve, bulk-resolve, replay on
--                           success) stamps resolved_at in the same UPDATE, so
--                           it is the finished clock. 'pending' and 'failed'
--                           rows are the morgue's open work: never deleted,
--                           whatever their age.
--   postmark_webhook_queue  processed_at IS NOT NULL AND processed_at <
--                           now() - 90 days, excluding a stale claim (error =
--                           'claimed_in_flight', POSTMARK-QUEUE-RECLAIM.1 —
--                           an unfinished event wearing a finished timestamp).
--                           Unprocessed rows, INCLUDING exhausted ones
--                           (attempts >= MAX_ATTEMPTS, processed_at NULL,
--                           POSTMARK-DLQ.1), are never deleted.
--
-- THE INDEXES
-- ───────────
-- Neither table's existing indexes serve the purge predicate:
--   webhook_dead_letter has (received_at) WHERE status = 'pending' and
--   (provider, status) — nothing on resolved_at, and the pending partial is
--   the complement of what the purge reads.
--   postmark_webhook_queue has (received_at) WHERE processed_at IS NULL and
--   (received_at DESC) — nothing on processed_at.
-- Each partial below indexes exactly the finished rows by their finished
-- clock, so the nightly `ORDER BY <clock> LIMIT n` scan is an index range read
-- and costs nothing on the live rows. Plain CREATE INDEX (not CONCURRENTLY),
-- inside the transaction, the way mig 584 did it: both tables are small.
--
-- THE HEARTBEAT
-- ─────────────
-- CLAUDE.md: route + vercel.json entry + stampHeartbeat() + THIS ROW, together.
-- Daily at 03:45 UTC (vercel.json). expected_interval 86400s, grace 43200s:
-- one missed day plus half a day before it pages. Born healthy (last_ok_at =
-- now()) so it cannot page before the first real tick — the mig 561/563
-- lesson, handled the way mig 584 handled purge-spam-tickets.
--
-- Forward-only and idempotent: IF NOT EXISTS on the indexes, ON CONFLICT on
-- the row. Applied by the orchestrator via Supabase MCP.

BEGIN;

-- ── webhook_dead_letter: finished rows by finished clock ─────────────
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letter_finished_purge
  ON public.webhook_dead_letter (resolved_at)
  WHERE status IN ('resolved', 'discarded');

-- ── postmark_webhook_queue: processed rows by processed clock ────────
CREATE INDEX IF NOT EXISTS idx_postmark_webhook_queue_processed_purge
  ON public.postmark_webhook_queue (processed_at)
  WHERE processed_at IS NOT NULL;

-- ── Heartbeat for the purge cron ────────────────────────────────────
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'purge-webhook-payloads',
  now(),
  86400,
  43200,
  'WEBHOOK-RETENTION.1 — daily 90-day retention purge of FINISHED webhook payload rows: webhook_dead_letter where status IN (resolved, discarded) AND resolved_at older than 90 days; postmark_webhook_queue where processed_at is set AND older than 90 days (stale claims excluded). Pending/failed dead letters and unprocessed (incl. exhausted) queue rows are never touched. Pages with .range(); bounded per run. Failures collected per table; stamps only when BOTH tables succeeded. Idle runs still stamp; last_outcome carries { cutoff, deleted: { webhook_dead_letter, postmark_webhook_queue }, pages }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

COMMIT;
