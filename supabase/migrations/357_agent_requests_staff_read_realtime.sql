-- 357: Inline inbox approvals — staff-wide read + realtime.
--
-- Approval cards render inside /communications/inbox threads and update
-- live (INBOX-APPROVALS). Two prerequisites:
--   1. SELECT widens from managers to any staff assigned to the
--      location — decision rights follow the comms surface (Richard,
--      2026-07-03). Browser realtime is RLS-bound, so without this
--      non-manager staff would never receive card events. RLS writes
--      stay manager-scoped (mig 320); inbox decisions go through the
--      service-role PATCH route, which enforces location access in
--      app code.
--   2. agent_membership_requests joins the supabase_realtime
--      publication (mig 042 pattern).

DROP POLICY IF EXISTS agent_membership_requests_read ON public.agent_membership_requests;
CREATE POLICY agent_membership_requests_read ON public.agent_membership_requests
  FOR SELECT TO authenticated
  USING (
    (SELECT private.auth_is_master())
    OR private.auth_is_manager_at(location_id)
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = agent_membership_requests.location_id
    )
  );

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_membership_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Partial index for the inbox queue-badge lookup
-- (.eq status='pending' .in conversation_id — INBOX-APPROVALS.10):
-- neither existing index covers conversation_id, and the table grows
-- unbounded as an audit trail. Pending rows are transient, so this
-- index stays tiny forever.
CREATE INDEX IF NOT EXISTS idx_agent_membership_requests_pending_conv
  ON public.agent_membership_requests (conversation_id)
  WHERE status = 'pending';
