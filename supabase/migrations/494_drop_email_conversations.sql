-- EMAIL-CONV-DROP.1 — retire email_conversations (mig 394).
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
--
-- The email channel moved from a conversation model to a TICKET model over
-- 2026-08-05..07 (migs 482/483/484/485). This drops the superseded table.
--
-- ── ORDER IS LOAD-BEARING. DROP THE FK FIRST. ──────────────────────
--
-- email_inbox_messages.conversation_id carries
-- `email_inbox_messages_conversation_id_fkey ... ON DELETE CASCADE`.
--
-- A plain DROP TABLE email_conversations would therefore CASCADE-DELETE every
-- message row still holding a conversation_id. Checked immediately before
-- writing this: that is TWO rows, and ONE OF THEM ALSO CARRIES A ticket_id —
-- it belongs to a live ticket an operator can open today. Dropping the table
-- naively would have silently removed a message from that thread, and the
-- second row would have gone entirely.
--
-- So: drop the constraint, THEN the table. No message row is touched by this
-- migration. Nothing is deleted except the one-row summary table itself, whose
-- columns (subject, preview, counterpart) are all duplicated on email_tickets.
--
-- ── WHY THIS IS SAFE NOW ───────────────────────────────────────────
--
-- EMAIL-CONV-STOP.1 (deployed) removed every read and write:
--   • the inbound webhook no longer dual-writes — and its tests make EVERY
--     email_conversations access throw, asserting the mail is still filed
--   • the tickets reply route no longer mirrors
--   • the three /api/email/conversations routes answer 410 Gone
--   • the web inbox dropped email (INBOX-SPLIT.1); mobile moved to
--     /api/email/tickets* (EMAIL-TICKET.6) and to its own tab (INBOX-SPLIT.M1)
-- `grep -rn "from('email_conversations')" src/ mobile/ shared/ scripts/` is empty.
--
-- Live state at the time of writing: 1 conversation row, last written
-- 2026-08-07 09:40Z — while messages continued to be written for hours after,
-- which is the observable signature of the dual-write being off.
--
-- ── WHAT IS DELIBERATELY NOT DROPPED ───────────────────────────────
--
-- email_inbox_messages.conversation_id stays, per the repo's
-- deprecated-columns-stay-on-disk convention: code stops writing it, a LATER
-- migration drops it, so a rollback needs no DB action. Its values become
-- dangling uuids, which is harmless and preserves the historical linkage.
--
-- One message row is left with a conversation_id and NO ticket_id — a
-- zero-byte "Test" self-sent from accounts@champfitness.ie to
-- accounts@hatchstreetfitness.com on 2026-08-05, i.e. the webhook wiring smoke
-- test. It survives this migration but is invisible to the ticket UI. It is
-- NOT deleted here and NOT force-attached to a ticket: minting a ticket for a
-- zero-byte test would put junk at the top of a live queue, and deleting a
-- message row is not something a cleanup migration should do unasked. An
-- operator can attach or delete it deliberately.

-- ── 1. Remove the CASCADE before anything can fire it ──────────────
ALTER TABLE public.email_inbox_messages
  DROP CONSTRAINT IF EXISTS email_inbox_messages_conversation_id_fkey;

COMMENT ON COLUMN public.email_inbox_messages.conversation_id IS
  'DEPRECATED (mig 485), DANGLING (mig 494) — email_conversations is dropped, so these uuids no longer reference anything. Never written since EMAIL-CONV-STOP.1. Retained per deprecated-columns-stay-on-disk; a later migration drops the column. Use ticket_id.';

-- ── 2. The unread counter has no table left to count ───────────────
DROP FUNCTION IF EXISTS public.increment_email_conversation_unread(uuid);

-- ── 3. The table. Its realtime publication membership goes with it. ─
DROP TABLE IF EXISTS public.email_conversations;
