-- 395: EMAIL-HYGIENE.1 — engagement-based email list hygiene.
--
-- docs/EMAIL_DELIVERABILITY.md prescribes suppressing ~90-day non-openers
-- as the biggest available deliverability lever ("Sending to dead addresses
-- is the fastest way to wreck domain reputation"). This adds a REVERSIBLE
-- suppression stamp on contacts — deliberately DISTINCT from consent:
-- email_marketing is the contact's choice; email_suppressed_at is OUR
-- hygiene call, cleared automatically the moment the contact opens or
-- clicks anything (postmark-webhook-processor) or re-consents via the
-- preference centre.
--
-- Stamped by the nightly email-engagement-sweep cron when ALL hold:
--   email_marketing = true, not already suppressed, ≥3 marketing sends in
--   the last 90 days, zero opens AND zero clicks in the last 90 days, and
--   first marketing send >90 days ago (thresholds in src/lib/email-hygiene.js).
--
-- Read by the marketing audience gate (buildAudienceQuery, consentField
-- 'email_marketing' only — administrative mail is never suppressed) and
-- by sequences' email step (recorded skip).

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_suppressed_at timestamptz;

COMMENT ON COLUMN contacts.email_suppressed_at IS
  'EMAIL-HYGIENE.1 (mig 395) — engagement-hygiene suppression stamp, set by the email-engagement-sweep cron on 90-day non-openers. NOT consent (that is email_marketing): this is our deliverability call, auto-cleared on any open/click or on re-consent via the preference centre. Marketing sends exclude contacts where this is non-null; administrative/transactional mail ignores it.';

-- The audience gate filters email_suppressed_at IS NULL on every marketing
-- count/send; suppressed rows are the small minority, so a partial index on
-- the non-null side keeps the "excluded for inactivity" count cheap.
CREATE INDEX IF NOT EXISTS idx_contacts_email_suppressed
  ON contacts (email_suppressed_at)
  WHERE email_suppressed_at IS NOT NULL;

-- The nightly sweep keyset-paginates consented, unsuppressed contacts by id.
CREATE INDEX IF NOT EXISTS idx_contacts_hygiene_scan
  ON contacts (id)
  WHERE email_marketing = true AND email_suppressed_at IS NULL;

-- Nightly sweep heartbeat (daily, generous grace — hygiene is not urgent).
INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds)
VALUES ('email-engagement-sweep', 86400, 21600)
ON CONFLICT (name) DO NOTHING;
