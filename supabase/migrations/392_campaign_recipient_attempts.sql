-- 392 — CAMPAIGN-REL: campaign send reliability (COMMS-AUDIT 2026-07-10).
--
-- Supports two fixes in src/lib/campaign-sender.js:
--
--   1. Bounded retry of TRANSIENT Postmark errors. Previously any
--      non-zero ErrorCode (including the synthetic -1 for a network
--      failure on the whole batch call) permanently marked the
--      recipient status='bounced'. Transient failures now return the
--      row to 'queued' with attempts+1, capped at MAX_SEND_ATTEMPTS
--      (3) then status='failed'.
--
--   2. Stuck-'sending' reclaim. If a cron invocation dies between the
--      queued→sending CAS claim and result application, rows sat in
--      'sending' forever and finalisation (which only checks remaining
--      'queued') closed the campaign as 'sent' around them. claimed_at
--      is stamped at claim time; rows still 'sending' after the lease
--      (10 min) — or with claimed_at IS NULL (pre-this-migration
--      strays) — are swept back to 'queued'/'failed' at tick start.
--
-- New status values used by code (status is free TEXT, no constraint
-- to alter): 'failed' (attempt cap exhausted / reclaim cap exhausted).
-- Campaign stat counters are computed from email_sends
-- (recalculate_campaign_stats, mig 157), so the new status cannot
-- corrupt stats.
--
-- Forward-only. Apply via Supabase MCP (apply_migration) against
-- un1t-crm (iyvtbjjxdggiadzwwvdj) BEFORE the code deploys, then run
-- get_advisors (security).

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

COMMENT ON COLUMN campaign_recipients.attempts IS
  'Completed send attempts (CAMPAIGN-REL, mig 392). Incremented on transient failure/reclaim; capped at 3 then status=failed.';
COMMENT ON COLUMN campaign_recipients.claimed_at IS
  'When the queued->sending CAS claim happened (CAMPAIGN-REL, mig 392). Lease clock for the stuck-sending sweep (10 min).';
COMMENT ON COLUMN campaign_recipients.last_error IS
  'Most recent Postmark/sweep error message for this recipient (CAMPAIGN-REL, mig 392). Diagnostic only.';

-- The sweep query is (campaign_id, status, claimed_at) — the existing
-- idx_campaign_recipients_campaign + _status indexes already serve it
-- for realistic campaign sizes; no new index needed.
