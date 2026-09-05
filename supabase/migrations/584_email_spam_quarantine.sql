-- 584 — MAIL-SPAM.1: spam quarantine for inbound mail.
--
-- WHY
-- ───
-- Postmark's inbound webhook has carried a SpamAssassin verdict (SpamScore +
-- the X-Spam-Status / X-Spam-Score headers) on every payload since the
-- channel went live, and nothing ever read it. Every piece of spam that
-- reached a configured mailbox opened a ticket, pushed staff, and lit the
-- needs-reply badge exactly like a member's email. This is the standard
-- shared-inbox posture instead: classify at ingest, QUARANTINE (never
-- delete), release on an operator's say-so, purge what is still quarantined
-- after 30 days.
--
-- THE SHAPE, AND WHY NOT `status`
-- ───────────────────────────────
-- A separate boolean, not a fifth `status` value. status is the lifecycle
-- (open/pending/solved/closed) and is re-derived by half a dozen writers
-- (the inbound bump reopens, the reply route moves to pending, archive
-- closes) — a `spam` status would be silently overwritten by the very next
-- inbound append. `is_spam` is orthogonal: a quarantined ticket keeps whatever
-- lifecycle state it has and is simply excluded from every view but Spam.
--
--   is_spam              the quarantine flag. NOT NULL DEFAULT false so every
--                        existing row is live, and every list scope can be a
--                        plain `.eq('is_spam', false)`.
--   spam_score           the SpamAssassin score the verdict was made on, kept
--                        on EVERY ticket that carried one (not just the
--                        quarantined ones) so a "why was this let through /
--                        why was this caught" question has an answer.
--   spam_flagged_at      when the flag was last SET. The 30-day purge clock
--                        runs from here, not from created_at: an operator
--                        marking a two-month-old thread as spam today gets 30
--                        days to change their mind, not zero.
--   spam_verdict_source  who decided: 'ingest' (the threshold) or 'operator'
--                        (Mark as spam / Not spam). Audit only.
--
-- FAIL OPEN, STATED IN THE SCHEMA TOO: spam_score is NULLABLE. A payload with
-- no readable score writes NULL and is_spam stays false — a lost lead is
-- worse than a spam ticket.
--
-- THE THRESHOLD IS PER LOCATION, on company_settings, beside the other
-- per-location email settings (send_quiet_hours_*, mig 514; email copy, mig
-- 530). Same pattern: column DEFAULTs cover a row that exists,
-- DEFAULT_EMAIL_SPAM_SETTINGS in src/lib/email-spam.js covers a location with
-- no company_settings row at all (most have never saved branding), and
-- normalizeSpamSettings() falls back per FIELD. 5.0 is SpamAssassin's own
-- default `required_score` and what Postmark's docs suggest as the line.
-- Read/write API: GET/PUT /api/locations/[id]/email-spam-filter (owner or
-- master AT THE TARGET location). Operator UI: Settings → Locations → <name>
-- → Details.
--
-- SHIP ORDER: apply BEFORE the code deploys (the webhook writes the new
-- columns on every inbound with a score; the list routes filter on is_spam).
-- The heartbeat row is born healthy (last_ok_at = now()) with a 36h window,
-- so it will not page before the daily cron's first real tick — the mig
-- 561/563 lesson, handled the way mig 573 handled it.

BEGIN;

-- ── email_tickets: the quarantine ───────────────────────────────────
ALTER TABLE public.email_tickets
  ADD COLUMN IF NOT EXISTS is_spam             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS spam_score          numeric(6,2),
  ADD COLUMN IF NOT EXISTS spam_flagged_at     timestamptz,
  ADD COLUMN IF NOT EXISTS spam_verdict_source text;

ALTER TABLE public.email_tickets
  DROP CONSTRAINT IF EXISTS email_tickets_spam_verdict_source_check;
ALTER TABLE public.email_tickets
  ADD CONSTRAINT email_tickets_spam_verdict_source_check
    CHECK (spam_verdict_source IS NULL OR spam_verdict_source IN ('ingest', 'operator'));

-- A quarantined row always knows when it was quarantined — the purge clock
-- depends on it. (The reverse is NOT enforced: a released row keeps
-- spam_flagged_at NULL, and the code clears it on release.)
ALTER TABLE public.email_tickets
  DROP CONSTRAINT IF EXISTS email_tickets_spam_flagged_at_when_spam;
ALTER TABLE public.email_tickets
  ADD CONSTRAINT email_tickets_spam_flagged_at_when_spam
    CHECK (NOT is_spam OR spam_flagged_at IS NOT NULL);

COMMENT ON COLUMN public.email_tickets.is_spam IS
  'MAIL-SPAM.1 (mig 584): quarantine flag. TRUE = hidden from every Mail view but Spam, no staff push, no unread/badge count; still stored in full. Set at ingest (SpamScore >= the location''s email_spam_threshold) or by an operator (Mark as spam); cleared by Not spam. Purged by /api/cron/purge-spam-tickets 30 days after spam_flagged_at.';
COMMENT ON COLUMN public.email_tickets.spam_score IS
  'MAIL-SPAM.1 (mig 584): the SpamAssassin score Postmark reported (SpamScore, else X-Spam-Score / X-Spam-Status), kept on every ticket that carried one so the verdict is auditable. NULL = no readable score, which is NEVER spam (fail open).';
COMMENT ON COLUMN public.email_tickets.spam_flagged_at IS
  'MAIL-SPAM.1 (mig 584): when is_spam was last set. The 30-day purge runs from here, so an operator marking an old thread as spam gets the full 30 days. NULL once released.';
COMMENT ON COLUMN public.email_tickets.spam_verdict_source IS
  'MAIL-SPAM.1 (mig 584): ''ingest'' = the threshold decided at the webhook; ''operator'' = Mark as spam / Not spam. Audit only.';

-- The purge's candidate scan: quarantined rows by age. Partial, so it costs
-- nothing on the ~all live rows and the daily cron reads exactly its
-- candidates in order.
CREATE INDEX IF NOT EXISTS idx_email_tickets_spam_purge
  ON public.email_tickets (spam_flagged_at)
  WHERE is_spam = true;

-- ── company_settings: the per-location threshold ────────────────────
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS email_spam_filter_enabled boolean      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS email_spam_threshold      numeric(4,1) NOT NULL DEFAULT 5.0;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_email_spam_threshold_range;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_email_spam_threshold_range
    CHECK (email_spam_threshold >= 0 AND email_spam_threshold <= 20);

COMMENT ON COLUMN public.company_settings.email_spam_filter_enabled IS
  'MAIL-SPAM.1 (mig 584): whether inbound mail at this location is quarantined by SpamScore at all. FALSE files everything normally (the score is still recorded). Owner/master at the location edits it.';
COMMENT ON COLUMN public.company_settings.email_spam_threshold IS
  'MAIL-SPAM.1 (mig 584): SpamAssassin score at or above which an inbound email is quarantined at this location. Default 5.0 (SpamAssassin''s own required_score). 0-20. A missing company_settings row means the code default (5.0), never "no filter".';

-- ── Heartbeat for the purge cron ────────────────────────────────────
-- CLAUDE.md: route + vercel.json entry + stampHeartbeat() + THIS ROW, together.
-- Daily at 03:15 (vercel.json). expected_interval 86400s, grace 43200s: one
-- missed day plus half a day before it pages, so a deploy window or a slow
-- night never cries wolf. Born healthy so it cannot page before the first
-- real tick — see the header.
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'purge-spam-tickets',
  now(),
  86400,
  43200,
  'MAIL-SPAM.1 — daily purge of email_tickets still quarantined (is_spam) 30 days after spam_flagged_at. Removes attachment storage objects and releases the bytes BEFORE deleting the rows (messages + attachment rows cascade). Pages with .range(); bounded per run. Stamps only when every page succeeded. Idle runs (nothing to purge) still stamp; last_outcome carries { tickets_deleted, attachments_removed, pages }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

COMMIT;
