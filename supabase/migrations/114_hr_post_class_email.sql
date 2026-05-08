-- 114_hr_post_class_email.sql
--
-- Post-class email infrastructure: a per-session stamp so the
-- sender is idempotent (cron retries don't double-send) plus a
-- per-member opt-out flag.
--
-- Why opt-out and not opt-in
-- --------------------------
-- The post-class email is transactional in character — it's about
-- the workout the member just did, not a marketing pitch. Members
-- expect Strava / Whoop / Garmin / etc to send these by default.
-- We mirror that: default true, single-click unsubscribe link in
-- every email flips this flag (not Postmark's global suppression,
-- which would also kill booking confirmations + invoices).
--
-- Where the cron picks up
-- -----------------------
-- The auto-end-stale-hr-sessions cron will scan
-- heart_rate_sessions WHERE ended_at IS NULL AND last_sample_at <
--   (now() - 5min). For each one it stamps ended_at + finalises
-- the summary (zones / points) and then triggers the email.
-- The email path filters WHERE email_sent_at IS NULL so a re-run
-- never double-sends.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS hr_post_class_emails_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.contacts.hr_post_class_emails_enabled IS
  'Send post-class HR summary emails. Default true (transactional). Unsubscribe link in the email flips this; Postmark global suppression is reserved for marketing only.';

ALTER TABLE public.heart_rate_sessions
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz;

-- Cron-friendly index: sessions ended (so the summary is finalised)
-- but the email hasn't gone out yet. Tiny over time — the cron picks
-- up rows seconds-to-minutes after they land.
CREATE INDEX IF NOT EXISTS idx_hr_sessions_email_pending
  ON public.heart_rate_sessions(ended_at DESC)
  WHERE ended_at IS NOT NULL AND email_sent_at IS NULL;
