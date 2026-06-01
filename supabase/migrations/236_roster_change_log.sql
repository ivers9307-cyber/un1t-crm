-- SCHEDULE-CHANGE-LOG.1 — audit trail for edits to an ALREADY-PUBLISHED
-- roster, and the source for "re-notify only the coaches who changed" on a
-- re-publish.
--
-- Rows are written by the assign / unassign / time-change routes ONLY when
-- the affected block belongs to a published roster (draft edits aren't
-- logged — those get the normal first-publish notification). On a
-- re-publish, the publish path notifies the distinct coaches of the
-- still-unnotified rows and stamps notified_at so they aren't re-pinged
-- on the next publish.

CREATE TABLE IF NOT EXISTS public.roster_change_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  block_id    uuid REFERENCES public.shift_blocks(id) ON DELETE SET NULL,
  block_date  date,
  actor_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  coach_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action      text NOT NULL CHECK (action IN ('assigned', 'unassigned', 'time_changed')),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Audit-view lookup (changes in a period, newest first) + the
-- unnotified-since-last-publish filter the re-publish notify uses.
CREATE INDEX IF NOT EXISTS idx_roster_change_log_loc_date
  ON public.roster_change_log (location_id, block_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_roster_change_log_unnotified
  ON public.roster_change_log (location_id, block_date)
  WHERE notified_at IS NULL;

ALTER TABLE public.roster_change_log ENABLE ROW LEVEL SECURITY;

-- Managers+ at the location can read the audit trail. All writes are
-- service-role (the API routes) — authenticated/anon have no write policy
-- so RLS denies them by default; service_role bypasses RLS.
CREATE POLICY roster_change_log_read ON public.roster_change_log
  FOR SELECT TO authenticated
  USING (private.auth_is_manager_at(location_id));

COMMENT ON TABLE public.roster_change_log IS
  'SCHEDULE-CHANGE-LOG.1 — audit of edits to already-published rosters; drives re-notify-changed-coaches on re-publish via notified_at.';
