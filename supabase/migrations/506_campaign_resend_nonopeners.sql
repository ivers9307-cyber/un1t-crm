-- 506 — CAMPAIGN-RESEND: auto-resend a marketing campaign to non-openers.
--
-- Configured at compose time (resend_enabled + resend_wait_hours +
-- optional resend_subject on the PARENT). Once the parent reaches
-- status='sent' and the wait elapses, run-campaigns spawns a CHILD
-- campaigns row (parent_campaign_id set) whose populate step resolves
-- the parent's non-openers at the last moment, re-checked against
-- contact_location_audience (mig 491) so consent / suppression /
-- bounces since the original send are honoured. One resend per
-- campaign, DB-enforced by the partial unique index (which doubles as
-- the race guard for overlapping cron ticks). Marketing (broadcast)
-- stream only — the outbound stream has open tracking off by design;
-- enforced in the app layer (email-draft route + spawnDueResends).

ALTER TABLE campaigns
  ADD COLUMN parent_campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN resend_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN resend_wait_hours INTEGER,
  ADD COLUMN resend_subject TEXT,
  ADD CONSTRAINT campaigns_resend_wait_hours_check
    CHECK (resend_wait_hours IS NULL OR (resend_wait_hours >= 1 AND resend_wait_hours <= 168));

-- One resend per campaign; also the concurrency guard: two cron ticks
-- both inserting the child race on this index, exactly one wins.
CREATE UNIQUE INDEX campaigns_one_resend_per_parent
  ON campaigns (parent_campaign_id) WHERE parent_campaign_id IS NOT NULL;

-- The spawn scan touches only flagged, finished parents.
CREATE INDEX idx_campaigns_resend_pending
  ON campaigns (sent_at) WHERE resend_enabled = true AND status = 'sent';

COMMENT ON COLUMN campaigns.parent_campaign_id IS 'Set on a resend child: the campaign this is a resend of (non-openers only).';
COMMENT ON COLUMN campaigns.resend_wait_hours IS 'Hours after sent_at before the non-opener resend spawns (1-168).';
COMMENT ON COLUMN campaigns.resend_subject IS 'Optional subject for the resend child; NULL reuses the parent''s effective subject.';
