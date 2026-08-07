-- EMAIL-TICKET.5 — who wrote it, and what they sign off with.
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
--
-- Two gaps found by working the queue for real (Richard, 2026-08-07):
--
-- 1. NO AUTHOR. email_inbox_messages records direction but not WHO. An
--    outbound reply and an internal note both say only "outbound", so the
--    thread cannot show "replied by Sarah" and a note cannot show who left it.
--    On a shared queue that is the difference between a conversation and a
--    pile of anonymous text — you cannot ask a colleague about their reply if
--    you cannot see it was theirs.
--
--    Nullable on purpose: inbound messages have no author, and messages
--    written before this migration have no way to acquire one. ON DELETE SET
--    NULL — a staff member leaving must never delete correspondence.
--
-- 2. NO SIGNATURE. Every reply went out unsigned. Stored per PROFILE, not per
--    location: a signature is a person's name and role, and someone working
--    two studios signs off the same way in both.
--
--    Plain text, not HTML. Replies are composed as plain text and converted on
--    send; a signature that could carry markup would be the one un-sanitised
--    HTML path into outbound mail.

ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS author_profile_id uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_inbox_messages.author_profile_id IS
  'EMAIL-TICKET.5: the staff member who wrote this message. NULL for inbound (no author) and for anything written before mig 493. ON DELETE SET NULL — a departing staff member must never delete correspondence.';

CREATE INDEX IF NOT EXISTS idx_email_msg_author
  ON public.email_inbox_messages (author_profile_id);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_signature text,
  ADD CONSTRAINT profiles_email_signature_len
    CHECK (email_signature IS NULL OR length(email_signature) <= 2000);

COMMENT ON COLUMN public.profiles.email_signature IS
  'EMAIL-TICKET.5: plain-text sign-off appended to this person''s ticket replies. Per profile, not per location — a signature is a name and a role, and someone working two studios signs off the same way in both. PLAIN TEXT deliberately: replies are composed as text and converted on send, so an HTML signature would be the one un-sanitised HTML path into outbound mail. NULL or empty = nothing appended.';
