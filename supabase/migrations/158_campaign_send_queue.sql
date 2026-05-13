-- ============================================================
-- 158: CAMPAIGN.13 — campaign-send queue + Postmark webhook queue
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- Two scaling issues hit when "15 mins?" actually shipped to ~3k
-- recipients:
--
--   (1) Postmark fired ~5k webhooks in 20s (delivery + open + click
--       + bounce events for ~3k emails). Each one ran 3-5 sequential
--       DB writes in our handler. Vercel either tripped its lambda
--       concurrency limit or our DB connection pool exhausted —
--       result was a "Massive burst, 8x faster failures, no error
--       logs, platform/validation level" alert, meaning many
--       webhooks 5xx'd before reaching our handler. Stats drift.
--
--   (2) sendCampaign loads the full audience and sends everything
--       in one synchronous flow, holding the operator's browser
--       open for the duration. Large sends approach Vercel's
--       function timeout, and operators have no way to know if it
--       worked without staying on the page.
--
-- The fix is a two-layer queue:
--
--   * postmark_webhook_queue — raw event payloads parked here by
--     the webhook handler (now a fast accept-and-store). A cron
--     drains them at controllable rate.
--   * campaign_recipients (existing) gains a 'queued' state per
--     row; a new cron sends in chunks of 500/min so the operator
--     can navigate away and we don't burst Postmark or our own
--     webhooks.
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
--   1. postmark_webhook_queue — id, payload, received_at,
--      processed_at, error, attempts. Partial index on rows
--      where processed_at IS NULL for fast pending lookup.
--
--   2. campaigns.cancel_requested_at — set by DELETE-while-sending.
--      The send cron checks it between chunks and stops cleanly,
--      flipping status to 'cancelled' and the remaining queued
--      recipients to 'cancelled' too.
--
--   3. Index on campaign_recipients (campaign_id, status) so the
--      chunk-picker query is index-only.
--
--   4. RLS: service_role full access on the queue (the webhook
--      handler + cron run as service_role); operators don't need
--      to read raw webhook payloads.

BEGIN;

-- ============================================================
-- STEP 1 — postmark_webhook_queue
-- ============================================================

CREATE TABLE IF NOT EXISTS postmark_webhook_queue (
  id           BIGSERIAL PRIMARY KEY,
  payload      JSONB        NOT NULL,
  received_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error        TEXT,
  attempts     INT          NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_postmark_webhook_queue_pending
  ON postmark_webhook_queue (received_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_postmark_webhook_queue_received
  ON postmark_webhook_queue (received_at DESC);

ALTER TABLE postmark_webhook_queue ENABLE ROW LEVEL SECURITY;

-- Only service_role touches the queue. Webhook handler runs as
-- service_role (via createServerClient), cron processor too. No
-- operator-facing read.
CREATE POLICY postmark_webhook_queue_service_role
  ON postmark_webhook_queue
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- STEP 2 — campaign cancellation flag
-- ============================================================

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

COMMENT ON COLUMN campaigns.cancel_requested_at IS
  'Set by DELETE-while-sending. The run-campaigns cron checks this between chunks and halts cleanly, transitioning status to ''cancelled''.';

-- ============================================================
-- STEP 3 — campaign_recipients (campaign_id, status) index
-- ============================================================
--
-- The send cron's chunk-picker query is:
--   SELECT id, contact_id FROM campaign_recipients
--   WHERE campaign_id = $1 AND status = 'queued'
--   ORDER BY id LIMIT 500
-- This index turns it index-only.

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_status
  ON campaign_recipients (campaign_id, status);

-- ============================================================
-- STEP 4 — campaigns(status, scheduled_at) for cron lookup
-- ============================================================
--
-- The run-campaigns cron's promotion query is:
--   SELECT id FROM campaigns
--   WHERE status = 'scheduled' AND scheduled_at <= now()
-- The chunk-loop query is:
--   SELECT id FROM campaigns
--   WHERE status IN ('queued','sending')

CREATE INDEX IF NOT EXISTS idx_campaigns_status_scheduled_at
  ON campaigns (status, scheduled_at)
  WHERE status IN ('scheduled','queued','sending');

-- ============================================================
-- STEP 5 — seed cron_heartbeats rows for the two new crons
-- ============================================================
--
-- Both crons run every minute (* * * * *). Heartbeat is stamped
-- via stampHeartbeat(name); the cron_health view treats a row as
-- stale if last_ok_at older than expected_interval + grace. 300s
-- grace mirrors the run-sms-broadcasts / run-sequences pattern.

INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('run-campaigns',              60, 300, 'CAMPAIGN.13 — paces campaign sends in 500-recipient chunks per tick'),
  ('process-postmark-webhooks',  60, 300, 'CAMPAIGN.13 — drains the postmark_webhook_queue (deferred processing)')
ON CONFLICT (name) DO NOTHING;

COMMIT;
