-- 711 — EVENT-MOVE.7: agent request kind 'event_move'.
--
-- WHY. Mia can now move a customer's event entry to another date, but never
-- directly: her move_event_entry tool files an agent_membership_requests row
-- for staff to approve, and approving it runs the shared move
-- (moveRegistration, mig 708) with actor_type 'agent'. The kind CHECK (last
-- set by mig 369) refuses any kind it does not list, so the request row
-- needs this kind first.
--
-- WHAT. One new kind appended to agent_membership_requests_kind_check;
-- every kind mig 369 allowed is kept. Nothing else changes. Safe to apply
-- before the code deploys (nothing writes the kind until it does), and the
-- file re-applies cleanly (drop if exists, then add).

alter table public.agent_membership_requests
  drop constraint if exists agent_membership_requests_kind_check;

alter table public.agent_membership_requests
  add constraint agent_membership_requests_kind_check
  check (kind = any (array[
    'pause'::text,
    'cancellation'::text,
    'class_booking'::text,
    'consultation'::text,
    'class_cancellation'::text,
    'event_booking'::text,
    'event_cancellation'::text,
    'membership_purchase'::text,
    'event_move'::text
  ]));
