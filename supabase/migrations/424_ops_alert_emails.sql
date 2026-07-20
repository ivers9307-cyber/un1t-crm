-- SAAS4-O2 — per-tenant ops-alert recipients (SaaS machinery plan §4).
-- Ops/billing notices (cap warnings, sync-stale, future token-expiring
-- and queue-backlog events) email these addresses via the Postmark
-- transactional stream. NULL/empty = pre-O2 behaviour (master-only
-- push), so this ships as a no-op until a tenant sets recipients.
-- Editable beside the hard caps on /settings/usage (owner or master).

ALTER TABLE org_settings
  ADD COLUMN ops_alert_emails TEXT[];

COMMENT ON COLUMN org_settings.ops_alert_emails IS
  'SAAS4-O2: org-level recipient emails for ops/billing alerts (cap 80% notices, per-tenant sync-stale). NULL/empty = master-only push fallback. Validated app-side (src/lib/ops-alerts.js parseOpsAlertEmails).';
