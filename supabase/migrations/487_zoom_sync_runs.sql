-- ZOOMOPS.1 — run history for the Zoom Phone contact sync.
--
-- cron_heartbeats.last_outcome (mig 486) holds ONE row and is overwritten
-- nightly, so "did last Tuesday also trip the guard?" is unanswerable. This is
-- the history behind that single value.
--
-- Written from inside runZoomContactSync() rather than by its callers, so every
-- trigger is recorded exactly once by construction and a future third trigger
-- inherits history for free.
--
-- organization_id is populated from day one even though only one value can
-- occur today (ZOOM_SYNC_ORGANIZATION_ID). Adding a tenant column to a table
-- that already holds live history means backfilling rows whose tenant must be
-- inferred — the migration that goes wrong. It costs nothing now.

CREATE TABLE IF NOT EXISTS public.zoom_sync_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,              -- NULL on an old row = the run died mid-flight
  trigger           text NOT NULL CHECK (trigger IN ('cron','manual')),
  triggered_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  dry               boolean NOT NULL DEFAULT false,
  forced            boolean NOT NULL DEFAULT false,
  limit_applied     integer,
  creates           integer,
  updates           integer,
  deletes           integer,
  enqueued          integer,
  guard_tripped     boolean NOT NULL DEFAULT false,
  guard_threshold   integer,
  guard_attempted   integer,
  guard_sample      text[],
  owned_in_zoom     integer,
  stats             jsonb,
  error             text
);

CREATE INDEX IF NOT EXISTS idx_zoom_sync_runs_recent
  ON public.zoom_sync_runs (organization_id, started_at DESC);

COMMENT ON COLUMN public.zoom_sync_runs.finished_at IS
  'NULL on a row older than a few minutes means the run crashed mid-flight — otherwise invisible.';
COMMENT ON COLUMN public.zoom_sync_runs.guard_sample IS
  'First 10 numbers the deletion guard refused. Rendered in the force-override confirmation so an operator approves a list they can read, not a count.';

ALTER TABLE public.zoom_sync_runs ENABLE ROW LEVEL SECURITY;

-- Reads only, and only for staff whose profile is attached to a location in the
-- run's organisation. Writes are service-role (the sync) and therefore bypass
-- RLS entirely — deliberately NO write policy rather than a restrictive one,
-- because a RESTRICTIVE ... FOR ALL ... USING (false) would also fold away this
-- SELECT policy and silently return an empty set (mig 483/485 class).
CREATE POLICY zoom_sync_runs_select ON public.zoom_sync_runs
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT l.organization_id FROM public.locations l
      JOIN public.profile_locations pl ON pl.location_id = l.id
      WHERE pl.profile_id = (SELECT auth.uid())
    )
  );
