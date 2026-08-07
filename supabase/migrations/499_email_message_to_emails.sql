-- EMAIL-CC.1 — multiple To recipients on a ticket message.
--
-- WHAT WAS MISSING AND WHAT WAS NOT
-- Mig 482 shipped `cc_emails` and `bcc_emails` on email_inbox_messages
-- (text[] NOT NULL DEFAULT '{}') and then nothing ever wrote them: Cc/Bcc were
-- in the spec, the columns landed, the wiring did not — the same shape as the
-- attachment pipeline sitting inert for two days. EMAIL-CC.1 is that wiring,
-- and for Cc and Bcc it needs NO schema change at all: the columns are already
-- there, already the right type, already commented.
--
-- The To side is the gap. `to_email` is a single `text`, so "email these three
-- people" had nowhere honest to live — comma-joining addresses into a scalar
-- would make every existing reader (the thread bubble's "Sent to …", the
-- contact history, the mobile screen) render a string that is not an address.
--
-- SO: an ARRAY BESIDE THE SCALAR, not instead of it.
--   • to_emails  — every To recipient, in order. The truth.
--   • to_email   — kept, and kept meaningful: the PRIMARY recipient, i.e.
--                  to_emails[1]. It is what email_sends logs, what the ticket's
--                  requester_email agrees with, and what every pre-EMAIL-CC.1
--                  reader already understands. Nothing is deprecated here and
--                  nothing needs a follow-up drop.
--
-- The backfill makes the two consistent for the whole back-catalogue, so no
-- reader ever has to special-case "rows written before 499" — an empty
-- to_emails on a row that has a to_email would otherwise read as "sent to
-- nobody" in exactly the surface (the thread) where that is worst.
--
-- INBOUND Cc GETS NO COLUMN because it already has one. The webhook simply
-- starts writing cc_emails (and to_emails) from Postmark's CcFull/ToFull.
-- bcc_emails stays '{}' on every inbound row forever: a Bcc is invisible to
-- the receiving server by construction, so we cannot know one existed.
--
-- NO INDEX. Nothing filters or joins on these — they are read as part of the
-- message row a ticket already fetches by ticket_id, and a GIN index on a
-- column no query searches is cost with no reader.

ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS to_emails text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.email_inbox_messages.to_emails IS
  'EMAIL-CC.1: every To recipient, in order. to_email remains the PRIMARY recipient (to_emails[1]) and is what email_sends logs — the two are kept consistent, not one deprecated in favour of the other.';

COMMENT ON COLUMN public.email_inbox_messages.cc_emails IS
  'EMAIL-CC.1 (column added inert by mig 482): Cc recipients. Written on outbound from the composer and on inbound from Postmark CcFull/ToFull. Visible to every recipient of the message, so it is safe to render anywhere the message itself is.';

-- Restates mig 482 with the rule EMAIL-CC.1 actually enforces. The original
-- wording ("read only by staff on the ticket") is unchanged in substance; what
-- is added is the second, easier-to-miss half — bcc_emails must never be an
-- INPUT to a later send. A reply, a reply-all and a forward on a ticket that
-- carried a Bcc reach exactly the people they would have reached had the Bcc
-- never been typed. src/lib/email-recipients.js threadParticipants() is the
-- only function that derives recipients from stored correspondence and it does
-- not name this column.
COMMENT ON COLUMN public.email_inbox_messages.bcc_emails IS
  'EMAIL-TICKET.1/EMAIL-CC.1: Bcc recipients of an OUTBOUND message. Put on the wire in Postmark''s own Bcc field (never a header, never folded into To/Cc) and thereafter readable only by staff on the ticket. MUST NEVER be rendered in any member-visible context, and MUST NEVER be read back as a recipient of a later reply or forward. Always empty on inbound: a Bcc is invisible to the receiving server.';

-- Back-catalogue: one To recipient, which is what every existing row is.
UPDATE public.email_inbox_messages
   SET to_emails = ARRAY[to_email]
 WHERE to_email IS NOT NULL
   AND (to_emails IS NULL OR cardinality(to_emails) = 0);
