-- 234: RADAR-AGENT Phase 2 — pause / cancellation approval queue.
--
-- The customer agent NEVER changes a membership itself. When a verified
-- member asks to pause or cancel, the agent captures the details and
-- writes a request here; a staff member approves/declines (and, for
-- cancellations, can try a retention save first). The actual change is
-- made in Glofox by staff after approval (no autonomous Glofox writes).
--
-- One row per request. RLS: read + write by managers at the location
-- (+ master). The agent writes via the service-role client (webhook
-- context, no user session), so the policies below govern operator
-- access in the dashboard; the service client bypasses RLS.

CREATE TABLE IF NOT EXISTS public.agent_membership_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('pause','cancellation')),
  -- where the request came from (which channel + conversation), so a
  -- human can open the thread and take over.
  channel         text CHECK (channel IN ('whatsapp','instagram')),
  conversation_id uuid,
  -- structured detail the agent captured, e.g.
  --   pause:        { start_date, end_date, reason }
  --   cancellation: { reason, desired_date }
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- free-text the customer gave, kept verbatim for context.
  customer_note   text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','declined','actioned','saved')),
  -- cancellations are flagged for a retention attempt by default; a
  -- staffer can mark it saved (kept the member) or let it proceed.
  retention_flagged boolean NOT NULL DEFAULT false,
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_membership_requests_location_status
  ON public.agent_membership_requests (location_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_membership_requests_contact
  ON public.agent_membership_requests (contact_id);

ALTER TABLE public.agent_membership_requests ENABLE ROW LEVEL SECURITY;

-- Read: managers at the location (+ master). Pending money-actions are
-- operator-sensitive, so scope to manager rather than all staff.
DROP POLICY IF EXISTS agent_membership_requests_read ON public.agent_membership_requests;
CREATE POLICY agent_membership_requests_read ON public.agent_membership_requests
  FOR SELECT TO authenticated
  USING (private.auth_is_master() OR private.auth_is_manager_at(location_id));

-- Write (approve/decline/save): managers at the location (+ master).
DROP POLICY IF EXISTS agent_membership_requests_write ON public.agent_membership_requests;
CREATE POLICY agent_membership_requests_write ON public.agent_membership_requests
  FOR ALL TO authenticated
  USING (private.auth_is_master() OR private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
