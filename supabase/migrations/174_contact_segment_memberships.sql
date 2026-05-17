-- SEG-TRIG.1 — Materialised segment membership for segment_added /
-- segment_removed sequence triggers.
--
-- contact_segments stores filter expressions only; it has no
-- membership rows. A contact "belongs" to a segment when their
-- attributes happen to satisfy the filter. Without stored
-- membership we can't compute either "added" or "removed"
-- transitions — every cron tick would have to scan the entire
-- contacts table per segment AND remember yesterday's result
-- in memory, which doesn't survive a cold start.
--
-- This table is the durable snapshot. A new cron
-- (/api/cron/sync-segment-memberships, every 5 min) recomputes
-- each segment's current member set from its filter, diffs
-- against the stored rows, INSERTs additions and DELETEs
-- removals, then fires segment_added / segment_removed
-- sequence triggers from the same diff.
--
-- The cron only touches segments referenced by an active
-- sequence with trigger_type IN ('segment_added',
-- 'segment_removed'). Most operators' saved filters are
-- one-off /contacts page convenience and never become a
-- sequence trigger — those never get a snapshot, no wasted
-- work.
--
-- Cascades:
--   • Segment deleted → all its memberships vanish (no
--     segment_removed triggers fire — deletion is a
--     different event class).
--   • Contact deleted → that contact's memberships vanish
--     (same reasoning).
--   • Contact attributes change → next cron tick picks up
--     the diff and fires the appropriate trigger.

CREATE TABLE IF NOT EXISTS public.contact_segment_memberships (
  segment_id UUID NOT NULL REFERENCES public.contact_segments(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (segment_id, contact_id)
);

-- Reverse lookup index — "which segments is this contact in?".
-- The PK already covers (segment_id, contact_id) queries.
CREATE INDEX IF NOT EXISTS idx_csm_contact
  ON public.contact_segment_memberships (contact_id);

ALTER TABLE public.contact_segment_memberships ENABLE ROW LEVEL SECURITY;

-- Read: same scope as the parent segment. Falls through to the
-- master / in-location predicate via the segment row. No direct
-- location_id column on this table — we keep it normalised and
-- read it through the FK.
DROP POLICY IF EXISTS contact_segment_memberships_select ON public.contact_segment_memberships;
CREATE POLICY contact_segment_memberships_select
  ON public.contact_segment_memberships
  FOR SELECT
  USING (
    private.auth_is_master()
    OR segment_id IN (
      SELECT id FROM public.contact_segments
      WHERE private.auth_is_in_location(location_id)
    )
  );

-- Writes: service-role only. The cron runs under service_role
-- which bypasses RLS, so no INSERT/UPDATE/DELETE policy needed
-- for normal operation. Belt-and-braces explicit deny for
-- authenticated + anon — there's no UI path that should write
-- here directly.
DROP POLICY IF EXISTS contact_segment_memberships_deny_writes ON public.contact_segment_memberships;
CREATE POLICY contact_segment_memberships_deny_writes
  ON public.contact_segment_memberships
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.contact_segment_memberships IS
  'SEG-TRIG.1 — durable snapshot of which contacts are in which segments. Maintained by /api/cron/sync-segment-memberships every 5 min. Drives segment_added / segment_removed sequence triggers.';

-- Seed the cron heartbeat row. stampHeartbeat() is UPDATE-only,
-- so the row has to pre-exist before the first run — the
-- "stampHeartbeat silent no-op" trap that bit mig 169 and three
-- subsequent crons. Same pattern as mig 173.
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('sync-segment-memberships', 300, 600,
   'SEG-TRIG.1 — every 5 min, recomputes segment memberships for any segment referenced by an active segment_added/segment_removed sequence and fires triggers on the diff. 10min grace covers cold-start + long member-page iteration.')
ON CONFLICT (name) DO NOTHING;
