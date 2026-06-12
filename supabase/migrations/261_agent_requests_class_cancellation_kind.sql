-- AGENT-CANCEL.1 — the agent can now cancel class bookings; every
-- attempt audits into agent_membership_requests like bookings do.
ALTER TABLE public.agent_membership_requests
  DROP CONSTRAINT IF EXISTS agent_membership_requests_kind_check;
ALTER TABLE public.agent_membership_requests
  ADD CONSTRAINT agent_membership_requests_kind_check
  CHECK (kind IN ('pause','cancellation','class_booking','consultation','class_cancellation'));
