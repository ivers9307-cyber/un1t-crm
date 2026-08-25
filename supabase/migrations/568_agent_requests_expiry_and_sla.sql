-- 568 — the approvals clock (MIA-BOARD.2)
--
-- agent_membership_requests had no aging and no expiry. Both failure shapes
-- went live before this: a member's cancellation sat pending 13 days
-- (12 Aug), and on 23 Aug two funnel bookings were approved AFTER their
-- classes had run — the executor booked them into Glofox anyway and sent
-- confirmations for finished classes (the Ciaran incident).
--
-- 1. status gains 'expired': a pending class_booking whose class has started
--    is flipped there by the approvals-sla sweep (lib/agent/approvals-sla.js)
--    or by the PATCH route's past-start execution guard. Expired rows stay
--    visible in /approvals — history, not deletion.
--    The list below extends the LIVE constraint definition (verified via
--    pg_get_constraintdef on 2026-08-25 — it had already drifted past mig 234
--    to include 'saved' and 'failed'); never rebuild it from an old migration.
-- 2. sla_escalated_at: the once-only stamp for the 24h "still pending"
--    manager re-alert (same once-per pattern as handoff_escalated_at).

alter table public.agent_membership_requests
  drop constraint agent_membership_requests_status_check;

alter table public.agent_membership_requests
  add constraint agent_membership_requests_status_check
  check (status = any (array[
    'pending'::text,
    'approved'::text,
    'declined'::text,
    'actioned'::text,
    'saved'::text,
    'failed'::text,
    'expired'::text
  ]));

alter table public.agent_membership_requests
  add column if not exists sla_escalated_at timestamptz;

comment on column public.agent_membership_requests.sla_escalated_at is
  'MIA-BOARD.2 (mig 568) — once-only stamp for the 24h still-pending manager re-alert (approvals-sla sweep). NULL = never escalated.';
