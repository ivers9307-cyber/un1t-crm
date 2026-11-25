-- 874 — INBOXFOLLOW.1: whose turn is a conversation in?
--
-- Nine nullable columns, no defaults, on both whatsapp_conversations and
-- instagram_conversations. Later tasks stamp them; this migration only adds
-- them and backfills the two that existing data can answer.
--
--   customer_waiting_since  the customer's unanswered inbound message
--   staff_owned_since       a person took the thread over
--   staff_waiting_since     staff owe the customer a reply (queue clock)
--   staff_nudged_at         last nudge sent to staff
--   staff_nudge_outcome     what the nudge led to
--   handoff_requested_at    Mia handed off and no person has answered
--   snoozed_until / snoozed_by / snooze_note   a staff snooze (note <= 140)
--
-- GRANT DECISION (docs/rules/data-access.md): both tables carry a table-level
-- SELECT for authenticated under RLS (wa_conv_select and its Instagram twin),
-- read-only for client sessions. All nine columns are safe for a staff session
-- with inbox access at that studio, so they are readable through the existing
-- grant and NO new grant is made. No client write privilege is added: every
-- write goes through a service-role route.
--
-- Forward-only and idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, and a backfill bounded to unresolved rows whose target is still NULL.
-- staff_waiting_since and staff_owned_since are deliberately not backfilled.

-- WhatsApp -------------------------------------------------------------------

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS customer_waiting_since timestamptz,
  ADD COLUMN IF NOT EXISTS staff_owned_since timestamptz,
  ADD COLUMN IF NOT EXISTS staff_waiting_since timestamptz,
  ADD COLUMN IF NOT EXISTS staff_nudged_at timestamptz,
  ADD COLUMN IF NOT EXISTS staff_nudge_outcome text,
  ADD COLUMN IF NOT EXISTS handoff_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS snooze_note text CHECK (char_length(snooze_note) <= 140);

CREATE INDEX IF NOT EXISTS whatsapp_conversations_staff_waiting_idx
  ON public.whatsapp_conversations (location_id)
  WHERE staff_waiting_since IS NOT NULL AND resolved_at IS NULL;

UPDATE public.whatsapp_conversations
SET customer_waiting_since = last_message_at
WHERE resolved_at IS NULL
  AND last_message_direction = 'inbound'
  AND customer_waiting_since IS NULL;

UPDATE public.whatsapp_conversations c
SET handoff_requested_at = c.agent_handed_off_at
WHERE c.resolved_at IS NULL
  AND c.agent_handed_off_at IS NOT NULL
  AND c.handoff_requested_at IS NULL
  AND (
    SELECT m.source
    FROM public.whatsapp_messages m
    WHERE m.conversation_id = c.id AND m.direction = 'outbound'
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) = 'agent';

-- Instagram ------------------------------------------------------------------

ALTER TABLE public.instagram_conversations
  ADD COLUMN IF NOT EXISTS customer_waiting_since timestamptz,
  ADD COLUMN IF NOT EXISTS staff_owned_since timestamptz,
  ADD COLUMN IF NOT EXISTS staff_waiting_since timestamptz,
  ADD COLUMN IF NOT EXISTS staff_nudged_at timestamptz,
  ADD COLUMN IF NOT EXISTS staff_nudge_outcome text,
  ADD COLUMN IF NOT EXISTS handoff_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS snooze_note text CHECK (char_length(snooze_note) <= 140);

CREATE INDEX IF NOT EXISTS instagram_conversations_staff_waiting_idx
  ON public.instagram_conversations (location_id)
  WHERE staff_waiting_since IS NOT NULL AND resolved_at IS NULL;

UPDATE public.instagram_conversations
SET customer_waiting_since = last_message_at
WHERE resolved_at IS NULL
  AND last_message_direction = 'inbound'
  AND customer_waiting_since IS NULL;

UPDATE public.instagram_conversations c
SET handoff_requested_at = c.agent_handed_off_at
WHERE c.resolved_at IS NULL
  AND c.agent_handed_off_at IS NOT NULL
  AND c.handoff_requested_at IS NULL
  AND (
    SELECT m.source
    FROM public.instagram_messages m
    WHERE m.conversation_id = c.id AND m.direction = 'outbound'
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) = 'agent';
