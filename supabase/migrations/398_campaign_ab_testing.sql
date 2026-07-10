-- 398 — CAMPAIGN-AB: subject-line A/B testing v1 (COMMS-AUDIT 2026-07-10).
--
-- Classic split test for one-shot campaigns: send variant A
-- (campaigns.subject) and variant B (campaigns.ab_subject_b) to a
-- small deterministic test slice of the audience, wait
-- ab_wait_hours, auto-pick the winner by open rate (ties / no data
-- → A), then send the remainder with the winning subject through
-- the normal chunked path (src/lib/campaign-sender.js).
--
-- Phase machine is column-driven, no new campaigns.status values:
--   ab_subject_b IS NULL                     → A/B off (default path,
--                                              byte-identical to today)
--   populated, ab_test_started_at IS NULL    → test slice sending
--   ab_test_started_at set, winner NULL,
--     now < started + ab_wait_hours          → waiting (ticks no-op)
--   wait elapsed, ab_winner IS NULL          → decide (CAS on
--                                              ab_winner IS NULL so
--                                              exactly one cron tick
--                                              decides)
--   ab_winner set                            → remainder sends with
--                                              the winning subject
--
-- Forward-only. Apply via Supabase MCP (apply_migration) against
-- un1t-crm (iyvtbjjxdggiadzwwvdj) BEFORE the code deploys, then run
-- get_advisors (security).

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS ab_subject_b TEXT,
  ADD COLUMN IF NOT EXISTS ab_test_pct INTEGER DEFAULT 10,
  ADD COLUMN IF NOT EXISTS ab_wait_hours INTEGER DEFAULT 4,
  ADD COLUMN IF NOT EXISTS ab_winner TEXT,
  ADD COLUMN IF NOT EXISTS ab_test_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ab_decided_at TIMESTAMPTZ;

-- Sane bounds enforced at the DB too (UI clamps, API zod-validates;
-- the campaign editor writes columns directly via the browser client
-- so a DB CHECK is the last line). CHECKs pass on NULL.
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_ab_test_pct_bounds
    CHECK (ab_test_pct IS NULL OR (ab_test_pct >= 5 AND ab_test_pct <= 50)),
  ADD CONSTRAINT campaigns_ab_wait_hours_bounds
    CHECK (ab_wait_hours IS NULL OR (ab_wait_hours >= 1 AND ab_wait_hours <= 24)),
  ADD CONSTRAINT campaigns_ab_winner_valid
    CHECK (ab_winner IS NULL OR ab_winner IN ('a', 'b'));

COMMENT ON COLUMN campaigns.ab_subject_b IS
  'Variant-B subject line (CAMPAIGN-AB, mig 398). NULL = A/B testing off; campaigns.subject is variant A.';
COMMENT ON COLUMN campaigns.ab_test_pct IS
  'Percent of the audience in the A/B test slice (CAMPAIGN-AB, mig 398). Bounds 5-50, default 10. Slice is split half A / half B.';
COMMENT ON COLUMN campaigns.ab_wait_hours IS
  'Hours to wait after the test slice finishes before deciding the winner by open rate (CAMPAIGN-AB, mig 398). Bounds 1-24, default 4.';
COMMENT ON COLUMN campaigns.ab_winner IS
  'Winning variant a|b (CAMPAIGN-AB, mig 398). Stamped once by the deciding cron tick (CAS on IS NULL); ties and zero-open data go to a.';
COMMENT ON COLUMN campaigns.ab_test_started_at IS
  'When the test slice finished sending and the wait clock started (CAMPAIGN-AB, mig 398). Stamped once (CAS on IS NULL).';
COMMENT ON COLUMN campaigns.ab_decided_at IS
  'When the winner was decided (CAMPAIGN-AB, mig 398).';

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS ab_variant TEXT;

ALTER TABLE campaign_recipients
  ADD CONSTRAINT campaign_recipients_ab_variant_valid
    CHECK (ab_variant IS NULL OR ab_variant IN ('a', 'b'));

COMMENT ON COLUMN campaign_recipients.ab_variant IS
  'A/B test slice assignment a|b (CAMPAIGN-AB, mig 398), stamped at populate time so the slice is stable across cron ticks. NULL = remainder (sends with the winning subject).';

-- Per-variant engagement rollup, read at decide time by the sender and
-- by the campaign detail page. Preferred over new counter columns
-- (single query, no webhook plumbing). Opens/sends are sourced from
-- email_sends — same source of truth as recalculate_campaign_stats
-- (mig 157) — joined per contact via campaign_recipients.ab_variant.
-- EXISTS (not JOIN) so a retry double-send can never double-count a
-- recipient.
CREATE OR REPLACE FUNCTION public.campaign_ab_variant_stats(p_campaign_id UUID)
RETURNS TABLE (ab_variant TEXT, sent_count BIGINT, opened_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    cr.ab_variant,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.email_sends es
      WHERE es.campaign_id = cr.campaign_id
        AND es.contact_id = cr.contact_id
        AND es.status IN ('sent', 'delivered', 'opened', 'clicked')
    )) AS sent_count,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.email_sends es
      WHERE es.campaign_id = cr.campaign_id
        AND es.contact_id = cr.contact_id
        AND es.opened_at IS NOT NULL
    )) AS opened_count
  FROM public.campaign_recipients cr
  WHERE cr.campaign_id = p_campaign_id
    AND cr.ab_variant IS NOT NULL
  GROUP BY cr.ab_variant;
$$;

-- service_role ONLY: both call sites (the campaign detail server page,
-- which runs assertLocationAccess before querying, and the campaign-
-- sender cron) use the service client. Granting authenticated would let
-- any signed-in user probe any campaign's variant stats by uuid via
-- /rest/v1/rpc (the estate audit's IDOR class) and add a SECURITY
-- DEFINER advisor warning for no benefit.
REVOKE EXECUTE ON FUNCTION public.campaign_ab_variant_stats(UUID)
  FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.campaign_ab_variant_stats(UUID)
  TO service_role;

-- No new index: the slice-phase chunk query filters
-- (campaign_id, status, ab_variant IS NOT NULL) and the decide query
-- groups a small slice — the existing campaign_id/status indexes on
-- campaign_recipients serve both at realistic campaign sizes.
