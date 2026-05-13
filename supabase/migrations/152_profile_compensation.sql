-- SECURITY.1 — move sensitive comp fields off profiles into a
-- separate table with master/owner-only RLS.
--
-- Why: profiles RLS lets every authenticated user read their own
-- row in full (mig 004 line 333 — "id = auth.uid()", no column
-- restriction). That meant any staff member with browser devtools
-- could query their own annual_salary / hourly_rate / etc. via a
-- direct Supabase JS call. The CRM UI never exposes the fields,
-- but the data was technically reachable.
--
-- This migration moves the 5 truly sensitive fields to a new
-- table with stricter RLS:
--   - annual_salary
--   - hourly_rate
--   - contracted_hours_per_week
--   - annual_leave_entitlement
--   - overtime_rate
--
-- employment_type stays on profiles — it's used as a discriminator
-- in 30+ legitimate reads (contract gating, invoice tab gating,
-- contractor invoice eligibility, etc.) and isn't sensitive
-- (a staff member already knows if they're FTE or contractor).
--
-- Old columns are LEFT IN PLACE per the codebase's "deprecated
-- columns kept on disk" convention (CLAUDE.md). After all readers
-- + writers are switched in this commit, a follow-up cleanup
-- migration drops them once we've confirmed no production traffic
-- still touches them.

-- 1. Create the table.
CREATE TABLE IF NOT EXISTS profile_compensation (
  profile_id                UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  annual_salary             NUMERIC(10,2),
  hourly_rate               NUMERIC(8,2),
  contracted_hours_per_week NUMERIC(5,1),
  annual_leave_entitlement  NUMERIC(5,1),
  overtime_rate             NUMERIC(8,2),
  -- Audit: who last touched it + when. Useful for the future
  -- "compensation history" UI a finance team will probably want.
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                UUID REFERENCES profiles(id) ON DELETE SET NULL
);

COMMENT ON TABLE profile_compensation IS
  'SECURITY.1 (mig 152): sensitive compensation fields moved off profiles. RLS allows only master + owner roles to SELECT/INSERT/UPDATE. employment_type stays on profiles — non-sensitive discriminator.';

-- 2. Backfill from profiles. ON CONFLICT DO NOTHING so re-running
--    the migration is safe.
INSERT INTO profile_compensation (
  profile_id,
  annual_salary,
  hourly_rate,
  contracted_hours_per_week,
  annual_leave_entitlement,
  overtime_rate,
  updated_at
)
SELECT
  id,
  annual_salary,
  hourly_rate,
  contracted_hours_per_week,
  annual_leave_entitlement,
  overtime_rate,
  COALESCE(updated_at, NOW())
FROM profiles
ON CONFLICT (profile_id) DO NOTHING;

-- 3. RLS — master + owner roles only. Same gate as the StaffForm
--    edit permission. Staff can't see anyone's compensation,
--    including their own. Service-role (server-side createServerClient)
--    bypasses RLS as usual, so server routes work unchanged.
ALTER TABLE profile_compensation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profile_compensation_select  ON profile_compensation;
DROP POLICY IF EXISTS profile_compensation_insert  ON profile_compensation;
DROP POLICY IF EXISTS profile_compensation_update  ON profile_compensation;

-- SELECT — master sees all, owner sees comp for staff at their
-- locations. We resolve "owner at any location of this staff
-- member" via profile_locations on both sides.
CREATE POLICY profile_compensation_select
  ON profile_compensation
  FOR SELECT
  USING (
    -- Master bypass: any master profile can read.
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'master'
    )
    OR
    -- Owner: caller is owner at AT LEAST ONE location where the
    -- target staff member is also assigned.
    EXISTS (
      SELECT 1
      FROM profile_locations caller_pl
      JOIN profile_locations target_pl
        ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = auth.uid()
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
    )
  );

CREATE POLICY profile_compensation_insert
  ON profile_compensation
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'master'
    )
    OR
    EXISTS (
      SELECT 1
      FROM profile_locations caller_pl
      JOIN profile_locations target_pl
        ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = auth.uid()
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
    )
  );

CREATE POLICY profile_compensation_update
  ON profile_compensation
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'master'
    )
    OR
    EXISTS (
      SELECT 1
      FROM profile_locations caller_pl
      JOIN profile_locations target_pl
        ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = auth.uid()
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
    )
  );

-- 4. Mark the source columns deprecated so the next person on the
--    codebase sees they're stale. Drop in a follow-up migration
--    after a verification window confirms no readers / writers
--    remain.
COMMENT ON COLUMN profiles.annual_salary IS
  'DEPRECATED (mig 152) — moved to profile_compensation.annual_salary. Will be dropped in a follow-up.';
COMMENT ON COLUMN profiles.hourly_rate IS
  'DEPRECATED (mig 152) — moved to profile_compensation.hourly_rate. Will be dropped in a follow-up.';
COMMENT ON COLUMN profiles.contracted_hours_per_week IS
  'DEPRECATED (mig 152) — moved to profile_compensation.contracted_hours_per_week. Will be dropped in a follow-up.';
COMMENT ON COLUMN profiles.annual_leave_entitlement IS
  'DEPRECATED (mig 152) — moved to profile_compensation.annual_leave_entitlement. Will be dropped in a follow-up.';
COMMENT ON COLUMN profiles.overtime_rate IS
  'DEPRECATED (mig 152) — moved to profile_compensation.overtime_rate. Will be dropped in a follow-up.';

-- 5. Sanity report — backfill should match profiles count.
DO $$
DECLARE
  profiles_count INT;
  comp_count INT;
BEGIN
  SELECT COUNT(*) INTO profiles_count FROM profiles;
  SELECT COUNT(*) INTO comp_count FROM profile_compensation;
  RAISE NOTICE 'SECURITY.1 mig 152: profiles=% profile_compensation=% (should match)', profiles_count, comp_count;
END $$;
