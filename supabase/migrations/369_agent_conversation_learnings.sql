-- 369 — Mia conversation-review fixes (2026-07-04).
--
-- 1. handoff_escalated_at on both agent conversation tables: the
--    AGENT-HANDOFF-SLA.1 sweep stamps it when it re-alerts managers
--    about a handed-off thread no human picked up within the SLA, so
--    each handoff escalates at most once.
-- 2. Widen agent_membership_requests.kind with 'membership_purchase':
--    Mia can now capture "yes, I'll take the offer" as a queued request
--    (request_membership_purchase tool) instead of a bare handoff.

alter table whatsapp_conversations
  add column if not exists handoff_escalated_at timestamptz;

alter table instagram_conversations
  add column if not exists handoff_escalated_at timestamptz;

alter table agent_membership_requests
  drop constraint agent_membership_requests_kind_check;

alter table agent_membership_requests
  add constraint agent_membership_requests_kind_check
  check (kind = any (array[
    'pause'::text,
    'cancellation'::text,
    'class_booking'::text,
    'consultation'::text,
    'class_cancellation'::text,
    'event_booking'::text,
    'event_cancellation'::text,
    'membership_purchase'::text
  ]));
