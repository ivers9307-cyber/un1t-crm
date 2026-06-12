-- AGENT-EVENTS.2/3 — the agent can book and (phase 3) cancel race/
-- event registrations; every attempt audits like class bookings do.
ALTER TABLE public.agent_membership_requests
  DROP CONSTRAINT IF EXISTS agent_membership_requests_kind_check;
ALTER TABLE public.agent_membership_requests
  ADD CONSTRAINT agent_membership_requests_kind_check
  CHECK (kind IN ('pause','cancellation','class_booking','consultation','class_cancellation','event_booking','event_cancellation'));
