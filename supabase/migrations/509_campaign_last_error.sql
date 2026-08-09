-- 509 — COMMSFIX.C.5: make a campaign that cannot send SAY SO.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- When a send tick fails — a broken audience filter, a schema drift like the
-- one mig 507 fixed, a Postmark outage — the trail is a Vercel log line and a
-- field in the cron's JSON response. The campaign row itself keeps status
-- 'queued', so /communications/sent shows an amber "queued" chip forever and no
-- operator surface anywhere says a word. The 8 Aug 2026 audience truncation sat
-- in this blind spot: campaigns.send_started_at was silently failing to write
-- on every campaign (mig 507) and nothing surfaced it.
--
-- WHAT IT DOES
-- ────────────
-- One nullable text column carrying the most recent failure. Written by:
--   • the run-campaigns cron, on every failing tick (and, once the campaign is
--     stuck — an error already on the row, populate never completed,
--     created more than 15 minutes ago — alongside status='failed');
--   • campaign-sender, when the email_sends insert for a chunk fails twice
--     (COMMSFIX.C.1) — a silent data loss that otherwise leaves every
--     engagement counter reading zero with no explanation.
--
-- Cleared by the manual re-send route, which also allows a 'failed' campaign to
-- be re-queued: the operator fixes the cause and sends again.
--
-- Read by /communications/sent as the status chip's title. NULLABLE with no
-- default — absence of an error is the normal state, and no backfill is
-- meaningful for history whose failures were never recorded.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_error TEXT;

COMMENT ON COLUMN campaigns.last_error IS
  'COMMSFIX.C.5 (mig 509) — most recent send failure for this campaign, stamped by the run-campaigns cron on every failing tick and by campaign-sender on a twice-failed email_sends insert. Cleared when the campaign is manually re-sent. Surfaced as the status chip title on /communications/sent.';
