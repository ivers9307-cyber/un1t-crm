-- MAIL-SENT.1 — does this conversation contain ANY received message?
--
-- WHY A COLUMN. The Inbox/Sent split follows the traditional mail-client
-- rule (Richard, 2 Sep — "Outlook, Google was the directive"): a thread
-- with any received mail lives in Inbox; an outbound-only thread lives in
-- Sent until a reply arrives. last_message_direction cannot answer this —
-- it flips back to 'outbound' every time staff reply — and an EXISTS over
-- email_inbox_messages per list row is neither indexable nor keyset-pageable.
-- So the fact is denormalised here, maintained at exactly the writes that
-- can change it: the inbound webhook (create + append set true), compose
-- (creates false), and merge (survivor ORs; unmerge recomputes both sides).
--
-- Default false + backfill: compose-born tickets stay false; anything that
-- ever received a real inbound (not an internal note) flips true.

ALTER TABLE public.email_tickets
  ADD COLUMN IF NOT EXISTS has_inbound boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.email_tickets.has_inbound IS
  'MAIL-SENT.1: true once the conversation contains any received (inbound, non-note) message. Inbox = live AND has_inbound; Sent = live AND NOT has_inbound. Maintained by the inbound webhook, compose, and merge/unmerge.';

UPDATE public.email_tickets t
SET has_inbound = true
WHERE EXISTS (
  SELECT 1 FROM public.email_inbox_messages m
  WHERE m.ticket_id = t.id
    AND m.direction = 'inbound'
    AND COALESCE(m.is_internal_note, false) = false
);
