-- EMAIL-DELIVERY.1 — per-message delivery status on outbound ticket mail.
--
-- WHY
-- A bounced reply and a delivered reply render identically in the ticket
-- thread today, so staff believe they answered someone they did not. Postmark
-- has been telling us the truth all along (Delivery / Bounce / SpamComplaint
-- webhooks, drained through postmark_webhook_queue) — we just never wrote it
-- down anywhere the thread could read.
--
-- WHAT IS ALREADY HERE, AND ISN'T BEING REBUILT
-- email_inbox_messages.postmark_message_id (mig 394) ALREADY holds Postmark's
-- API MessageID, written at send time by both /api/email/tickets/[id]/reply and
-- /api/email/tickets/compose, and it already carries a UNIQUE partial index
-- (idx_email_msg_postmark_id). That is the whole correlation key and it needs
-- no new column and no new index: an event lookup is
-- `postmark_message_id = ? AND direction = 'outbound'`, which that index serves
-- exactly. This migration only adds the place to PUT the answer.
--
-- WHY NOT REUSE email_inbox_messages.status
-- That column is the message's OWN lifecycle and its vocabulary is already
-- spoken for — 'sent' (outbound reply), 'note' (internal note, never sent at
-- all) and 'received' (inbound). Overloading it would mean an internal note and
-- a delivered reply competing for the same field, and every existing writer
-- would have to learn a second meaning. Delivery is a different fact about the
-- row, told by a different party, arriving later. It gets its own columns.
--
-- THE STATE MODEL — THREE STATES, AND NULL IS ONE OF THEM
--   NULL        we sent it and no provider event has arrived. This is every
--               outbound row the instant it is written, every row in the
--               back-catalogue, and the permanent resting state of any message
--               whose event is lost or never sent. It is DELIBERATELY NOT a
--               value like 'pending': nothing guarantees an event ever arrives,
--               and a stored 'pending' invites a UI that promises an answer
--               that is never coming. "Sent, and we have heard nothing" and
--               "we know nothing" are the same epistemic state.
--   'delivered' Postmark handed it to the recipient's mail server.
--   'complained' the recipient marked it as spam. They DID receive it.
--   'bounced'   it came back. The member never read the answer.
--
-- TRANSITIONS ARE A SEVERITY LATTICE, NOT LAST-WRITE-WINS.
-- Rank: NULL 0 < delivered 1 < complained 2 < bounced 3. An event applies only
-- if its rank is STRICTLY GREATER than what is stored. So a Delivery arriving
-- after a Bounce (out-of-order webhooks, or a redelivery of an old event) can
-- never repaint a bounce as fine, a duplicate event is a no-op, and a bounce
-- that follows an accepted-then-rejected delivery still wins. Enforced
-- atomically in the UPDATE's own WHERE clause (src/lib/email-delivery-status.js
-- builds it), because the QStash worker and the drain cron process different
-- queue rows concurrently by design.
--
-- RLS: NOTHING TO DO, AND THAT IS THE POINT. RLS binds tables, not columns, and
-- email_inbox_messages already has its per-command policies from mig 485
-- (email_msg_select permissive SELECT + separate deny_insert/update/delete,
-- which is what replaced the RESTRICTIVE FOR ALL that was silently killing
-- SELECT). Adding a policy here would either duplicate the SELECT policy
-- (multiple_permissive_policies) or re-introduce the FOR ALL class. Writes are
-- service-role only, exactly as before.

ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS delivery_status      text,
  ADD COLUMN IF NOT EXISTS delivery_status_at   timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_detail      text,
  ADD COLUMN IF NOT EXISTS delivery_bounce_type text;

-- CHECKs are NOT NULL-hostile: `NULL` passes a CHECK, which is what keeps the
-- "no event yet" state legal without a sentinel value.
ALTER TABLE public.email_inbox_messages
  DROP CONSTRAINT IF EXISTS email_msg_delivery_status_check;
ALTER TABLE public.email_inbox_messages
  ADD CONSTRAINT email_msg_delivery_status_check
  CHECK (delivery_status IS NULL OR delivery_status IN ('delivered','bounced','complained'));

ALTER TABLE public.email_inbox_messages
  DROP CONSTRAINT IF EXISTS email_msg_delivery_bounce_type_check;
ALTER TABLE public.email_inbox_messages
  ADD CONSTRAINT email_msg_delivery_bounce_type_check
  CHECK (delivery_bounce_type IS NULL OR delivery_bounce_type IN ('hard','soft','transient'));

COMMENT ON COLUMN public.email_inbox_messages.delivery_status IS
  'EMAIL-DELIVERY.1: provider delivery outcome for an OUTBOUND message. NULL = sent, no Postmark event yet (also the resting state for a lost event) — never render it as either delivered or failed. Transitions follow a severity lattice (delivered < complained < bounced); a lower-ranked event NEVER overwrites a higher one, so a late Delivery cannot erase a Bounce.';
COMMENT ON COLUMN public.email_inbox_messages.delivery_status_at IS
  'EMAIL-DELIVERY.1: when the provider event OCCURRED (DeliveredAt / BouncedAt), not when we processed it. Falls back to processing time only if Postmark sent an unparseable stamp.';
COMMENT ON COLUMN public.email_inbox_messages.delivery_detail IS
  'EMAIL-DELIVERY.1: Postmark''s own explanation, Description + Details joined (capped 500 chars) — this is what tells staff "mailbox full" from "no such address". NULL for a plain delivery.';
COMMENT ON COLUMN public.email_inbox_messages.delivery_bounce_type IS
  'EMAIL-DELIVERY.1: hard | soft | transient, normalised from Postmark''s Type with the SAME mapping email_sends.bounce_type uses, so the two never disagree about the same event. Drives which advice the thread shows; the specific reason is in delivery_detail.';

-- NO NEW INDEX, DELIBERATELY. The only lookup this feature performs is by
-- postmark_message_id, which mig 394's UNIQUE partial index
-- (idx_email_msg_postmark_id) already covers. Nothing queries BY
-- delivery_status yet — the thread reads it off rows it already fetched by
-- ticket_id — and an index nobody uses is write cost for no read.
