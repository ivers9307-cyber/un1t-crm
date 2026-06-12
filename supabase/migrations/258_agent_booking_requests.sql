-- AGENT-HANDS.1 — the customer agent gains booking abilities (class
-- bookings for verified members, consultation bookings for leads).
-- Reuses agent_membership_requests as the single "agent asked for /
-- did something" queue + audit trail rather than a parallel table:
--   kind gains 'class_booking' + 'consultation'
--   status gains 'failed' (an approved booking whose Glofox execution
--   errored — stays visible instead of vanishing)
-- details jsonb carries the booking payload + execution result, e.g.
--   class_booking: { event_id, event_name, time_start, mode,
--                    result: { ok, status, message_code } }
ALTER TABLE public.agent_membership_requests
  DROP CONSTRAINT IF EXISTS agent_membership_requests_kind_check;
ALTER TABLE public.agent_membership_requests
  ADD CONSTRAINT agent_membership_requests_kind_check
  CHECK (kind IN ('pause','cancellation','class_booking','consultation'));

ALTER TABLE public.agent_membership_requests
  DROP CONSTRAINT IF EXISTS agent_membership_requests_status_check;
ALTER TABLE public.agent_membership_requests
  ADD CONSTRAINT agent_membership_requests_status_check
  CHECK (status IN ('pending','approved','declined','actioned','saved','failed'));
