-- ============================================================
-- 081: Teams + race tracking for timed events (Hyrox sims, etc)
--
-- Three concepts land in this migration:
--
--   1. teams — first-class identity for a competing team. Persists
--      across events so returning teams ("the Iron Dogs") link back
--      to the same row each time. UNIQUE (location_id, name) means
--      operators don't have to manually deduplicate spelling
--      variations — any future booking using the exact same name
--      lands on the same team. Variations like "Iron Dogs" vs "iron
--      dogs" are distinct rows; that's a tradeoff (case-sensitivity)
--      we'll revisit if it becomes a real pain. For now, simple is
--      better.
--
--   2. team_members — who's on which team. Captain (set at signup)
--      always has contact_id populated because they're the person
--      who filled out the booking form. Other members (entered as
--      name+email by the captain at booking time) get contact_id
--      NULL — they exist as team_members but not yet as standalone
--      contacts in the CRM. Promoting a member to a real contact
--      can be a v2 admin action; v1 leaves them on team_members
--      only.
--
--   3. Race timing on bookings — race_started_at + race_finished_at
--      are timestamptz columns set by the race-control UI when an
--      operator taps Start / Finish at the start/finish line. Pure
--      append-only data — never edited, only set. Operator mistake
--      undo lives in the race-reset API route (clears both back to
--      NULL).
--
-- Plus event_types extensions:
--   - is_timed_event       — opt-in flag for the whole feature
--   - allowed_team_sizes   — INT[] like {1,2,4}; the booking widget
--                            shows a radio constrained to these sizes,
--                            and renders N-1 additional name+email
--                            input pairs at signup time.
-- ============================================================

BEGIN;

-- ─── teams ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS teams (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  size                INT,
  captain_contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, name)
);

COMMENT ON TABLE teams IS
  'Competing teams in timed events (Hyrox sims, etc). Persists across events — a returning team books with the same name and links to the same row via the (location_id, name) UNIQUE constraint. Captain is the person who registered (booking_widget submitter); other members are captured as team_members rows but may not have contact_id set until they show up in the CRM separately.';

COMMENT ON COLUMN teams.size IS
  'Number of competing members. Captured at signup from the team_size radio in the booking widget. Constrained to event_types.allowed_team_sizes by the booking API.';

CREATE INDEX IF NOT EXISTS idx_teams_location ON teams (location_id);
CREATE INDEX IF NOT EXISTS idx_teams_captain ON teams (captain_contact_id) WHERE captain_contact_id IS NOT NULL;

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teams_location_scoped ON teams;
CREATE POLICY teams_location_scoped ON teams
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  )
  WITH CHECK (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

-- updated_at trigger
CREATE OR REPLACE FUNCTION private.touch_teams_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS teams_touch_updated_at ON teams;
CREATE TRIGGER teams_touch_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION private.touch_teams_updated_at();

-- ─── team_members ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  email       TEXT,
  role        TEXT NOT NULL DEFAULT 'member',
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT team_members_role_check CHECK (role IN ('captain', 'member'))
);

COMMENT ON TABLE team_members IS
  'People on a team. Captain row has contact_id set (they filled out the booking form, so they exist as a contact). Non-captain members have name+email captured at signup but contact_id is typically NULL until they enter the CRM separately. Linking later is a manual / v2 admin action.';

CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_contact ON team_members (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

-- Read/write scoped via the parent team's location.
DROP POLICY IF EXISTS team_members_location_scoped ON team_members;
CREATE POLICY team_members_location_scoped ON team_members
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.id = team_members.team_id
        AND private.auth_is_in_location(t.location_id)
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.id = team_members.team_id
        AND private.auth_is_in_location(t.location_id)
    )
  );

-- ─── bookings — race timing + team link ──────────────────────────

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS team_id           UUID REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS race_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS race_finished_at  TIMESTAMPTZ;

COMMENT ON COLUMN bookings.team_id IS
  'Optional link to a team for timed events. NULL for non-timed events; auto-set by the booking widget for timed events; auto-created from customer_name on first race-UI open if somehow missing.';

COMMENT ON COLUMN bookings.race_started_at IS
  'Timestamp when an operator tapped Start in the race-control UI. NULL until the race begins. Sanity: race_finished_at must be > race_started_at when both are set (not enforced via CHECK because the race-reset undo path nulls both, and intermediate states during operator mistakes happen).';

COMMENT ON COLUMN bookings.race_finished_at IS
  'Timestamp when an operator tapped Finish in the race-control UI. NULL until the team crosses the line. Elapsed time is computed in queries as race_finished_at - race_started_at.';

CREATE INDEX IF NOT EXISTS idx_bookings_team ON bookings (team_id) WHERE team_id IS NOT NULL;
-- Partial index supporting the race-UI's "active teams" query: timed
-- events on a given date that are currently on course (started, not
-- finished). The full table scan would be tiny in practice, but the
-- query runs on a 2s poll so let's keep it indexed.
CREATE INDEX IF NOT EXISTS idx_bookings_race_active
  ON bookings (event_type_id, race_started_at)
  WHERE race_started_at IS NOT NULL AND race_finished_at IS NULL;

-- ─── event_types — timed-event opt-in + allowed team sizes ───────

ALTER TABLE event_types
  ADD COLUMN IF NOT EXISTS is_timed_event       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS allowed_team_sizes   INT[];

COMMENT ON COLUMN event_types.is_timed_event IS
  'When TRUE, bookings for this event get the race-control UI treatment: team capture at signup, /events/[id]/race operator interface, race timing via race_started_at + race_finished_at on the booking row.';

COMMENT ON COLUMN event_types.allowed_team_sizes IS
  'INT[] of team sizes the booking widget will offer (e.g. {1,2,4}). NULL or empty means the event allows any positive integer (the widget will show a free-form size input). Constrained server-side in the public book route.';

COMMIT;
