-- 281: race_checkins — per-person event attendance (EVENT-CHECKIN.A)
--
-- One row per checked-in person per registration. Presence = checked in;
-- deleting the row = undo. No-show stays a derived concept (confirmed
-- registration + event date passed + zero check-in rows) — no new status.
--
-- On its own table (not a column on team_members) because a team can be
-- registered to more than one event, so attendance must be scoped to the
-- registration, not the person globally. location_id is denormalised for
-- a clean per-location RLS policy.

CREATE TABLE IF NOT EXISTS public.race_checkins (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  race_registration_id uuid NOT NULL REFERENCES public.race_registrations(id) ON DELETE CASCADE,
  team_member_id       uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  contact_id           uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  location_id          uuid NOT NULL REFERENCES public.locations(id),
  checked_in_at        timestamptz NOT NULL DEFAULT now(),
  checked_in_by        uuid REFERENCES public.profiles(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT race_checkins_unique_member UNIQUE (race_registration_id, team_member_id)
);

CREATE INDEX IF NOT EXISTS idx_race_checkins_registration ON public.race_checkins (race_registration_id);
CREATE INDEX IF NOT EXISTS idx_race_checkins_location     ON public.race_checkins (location_id);
CREATE INDEX IF NOT EXISTS idx_race_checkins_contact      ON public.race_checkins (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.race_checkins ENABLE ROW LEVEL SECURITY;

-- Authenticated (browser) may READ check-ins for their own locations.
-- Every API route writes via the service-role client (RLS-bypassing); this
-- policy is defence-in-depth and mirrors the _location_scoped pattern.
DROP POLICY IF EXISTS "race_checkins_location_scoped_select" ON public.race_checkins;
CREATE POLICY "race_checkins_location_scoped_select" ON public.race_checkins
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.race_checkins IS
  'Per-person event attendance (EVENT-CHECKIN.A, mig 281). One row per checked-in team_member per registration; presence = checked in, deletion = undo. No-show is derived (confirmed registration + event passed + no row). location_id denormalised for RLS.';
