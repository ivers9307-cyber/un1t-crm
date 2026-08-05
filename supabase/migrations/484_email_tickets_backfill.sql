-- EMAIL-TICKET.1 — backfill: one ticket per existing conversation.
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
--
-- THIS IS A NO-OP IN PRODUCTION TODAY. Checked 2026-08-05 before writing it:
-- email_conversations and email_inbox_messages are both EMPTY (0 rows). The
-- email channel from mig 394 has never received a single message, despite one
-- mailbox being configured. So the only lasting effect of this migration is the
-- DEPRECATED comment at the bottom.
--
-- It is written properly anyway, because a fresh-env replay or a late-arriving
-- message must be handled correctly, and because the verification that follows
-- it is vacuous on empty tables (0 == 0 passes whatever the mapping does). Its
-- correctness is therefore effectively unexercised until real mail exists —
-- deliberately NOT papered over by seeding synthetic rows into production.
--
-- REUSING THE UUID IS THE WHOLE TRICK
-- Each ticket takes its conversation's id verbatim. That buys three things:
--   • idempotency is a plain ON CONFLICT DO NOTHING
--   • mapping messages is `ticket_id := conversation_id`, no join table, no
--     temp mapping, no second pass
--   • debugging a backfilled row against the old table is a straight id match
--
-- WHY SQL AND NOT A SCRIPT
-- A JS backfill would hit the 1,000-row select cap and need .range() paging
-- with an explicit .order(). Set-based SQL has no such cap and is atomic.
--
-- STATUS MAPPING
-- mig 394 had two states via resolved_at. resolved maps to 'solved', NOT
-- 'closed': an operator who marked a thread handled did not thereby consent to
-- it never accepting a reply again, and 'solved' still reopens on inbound.
-- Choosing 'closed' would silently fork every future reply into a new ticket.

INSERT INTO public.email_tickets (
  id, location_id, contact_id, requester_email, requester_name, subject,
  status, assigned_to,
  last_message_at, last_message_direction, last_message_preview, unread_count,
  solved_at, created_at, updated_at
)
SELECT
  c.id,
  c.location_id,
  c.contact_id,
  c.counterpart_email,
  c.counterpart_name,
  coalesce(nullif(btrim(c.subject), ''), '(no subject)'),
  CASE WHEN c.resolved_at IS NOT NULL THEN 'solved' ELSE 'open' END,
  c.assigned_to,
  c.last_message_at,
  c.last_message_direction,
  c.last_message_preview,
  coalesce(c.unread_count, 0),
  c.resolved_at,
  c.created_at,
  c.updated_at
FROM public.email_conversations c
ON CONFLICT (id) DO NOTHING;

-- Messages inherit the mapping directly, since ticket id == conversation id.
-- The conversation_id IS NOT NULL guard matters now that mig 483 made that
-- column nullable: a ticket-only message must not be dragged backwards into a
-- conversation that does not exist.
UPDATE public.email_inbox_messages
   SET ticket_id = conversation_id
 WHERE ticket_id IS NULL
   AND conversation_id IS NOT NULL;

COMMENT ON TABLE public.email_conversations IS
  'DEPRECATED (mig 484) — superseded by email_tickets. Retained read-only for one release so a rollback needs no DB action; dropped in a later migration. Do not write to this table. Its UNIQUE idx_email_conv_location_counterpart is the immortal-thread model email_tickets exists to replace.';
