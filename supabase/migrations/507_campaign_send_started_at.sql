-- CAMPAIGN.14 — schema drift: campaign-sender's populate update has written
-- campaigns.send_started_at since CAMPAIGN.13, but no migration ever added
-- the column, so the whole UPDATE (status='sending', total_recipients)
-- failed silently on every campaign (PGRST204; the error was unchecked).
-- Campaigns still reached 'sent' via finalise + recalculate_campaign_stats,
-- which masked populate failures — including the 8 Aug 2026 audience
-- truncation. Add the column the code already writes.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_started_at timestamptz;

COMMENT ON COLUMN campaigns.send_started_at IS
  'When recipient populate completed and sending began (stamped by campaign-sender; added mig 507 after schema drift since CAMPAIGN.13)';
