-- SAAS4-M3 — once-per-month bookkeeping for the 80%-of-hard-cap
-- notices (SaaS machinery plan §3). The usage-rollup cron checks each
-- org with a hard cap set after its nightly rollup; when spend/sends
-- cross 80% of the cap and no notice has gone out this Dublin month,
-- managers at the org's locations get a push and the month is stamped
-- here so the notice fires once, not nightly.

ALTER TABLE org_settings
  ADD COLUMN ai_cap_notice_month TEXT
    CHECK (ai_cap_notice_month IS NULL OR ai_cap_notice_month ~ '^\d{4}-\d{2}$'),
  ADD COLUMN email_cap_notice_month TEXT
    CHECK (email_cap_notice_month IS NULL OR email_cap_notice_month ~ '^\d{4}-\d{2}$');

COMMENT ON COLUMN org_settings.ai_cap_notice_month IS
  'SAAS4-M3: Dublin month (YYYY-MM) the 80%-of-AI-hard-cap notice last went out. Guards the once-per-month push.';
COMMENT ON COLUMN org_settings.email_cap_notice_month IS
  'SAAS4-M3: Dublin month (YYYY-MM) the 80%-of-email-hard-cap notice last went out.';
