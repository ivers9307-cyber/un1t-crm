-- ============================================================
-- 302: add campaigns.postmark_stream (Marketing/Utility send type)
--
-- HOTFIX. The Marketing/Utility feature (PR #615) assumed
-- campaigns.postmark_stream already existed (the postmark_stream line
-- in mig 005 is on email_sends — the per-send log — NOT campaigns; the
-- two were conflated). The column was never on campaigns, so the
-- preview SELECT, the email-draft INSERT, and the CampaignEditor save
-- all referenced a non-existent column → PostgREST errored → the
-- recipient-count banner showed "Campaign not found" and new-campaign
-- creation failed.
--
-- This adds the column the feature code already expects. Additive,
-- default 'broadcast' so every existing campaign is unchanged
-- (Marketing). CHECK pins the two valid streams.
-- ============================================================

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS postmark_stream TEXT NOT NULL DEFAULT 'broadcast';

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_postmark_stream_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_postmark_stream_check
  CHECK (postmark_stream IN ('broadcast', 'outbound'));

COMMENT ON COLUMN campaigns.postmark_stream IS
  'Marketing (broadcast) vs Utility (outbound/transactional) send type. broadcast gates the audience on email_marketing + appends the unsubscribe footer; outbound gates on email_administrative + no marketing chrome. Driven by the email_type selector (mig 302 / PR #615 follow-up).';

COMMIT;
