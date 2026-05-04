-- ============================================================
-- 082: Standalone race events (unmerge from booking flow)
--
-- Mig 081 shoehorned race tracking into the booking flow by adding
-- is_timed_event + allowed_team_sizes to event_types and team_id +
-- race_started/finished_at to bookings. The Calendly-style booking
-- widget tried to render team-capture fields conditionally; the
-- operator UI lived under /events/[id]/race; the slot generator
-- still produced calendar-style time slots which don't match how
-- a race actually works (one event date, teams register, race
-- runs).
--
-- This migration creates first-class standalone race entities so
-- races can have their own URL structure, operator pages, signup
-- form, registration window enforcement, and capacity model — none
-- of which the booking-event abstraction provided cleanly.
--
-- Two new tables:
--   1. race_events — one per race occurrence (every-6-weeks Hyrox
--      sim, etc). Per-location. Independent of event_types.
--   2. race_registrations — one per team registered for one race
--      event. Replaces the bookings.race_started/finished_at
--      pattern from mig 081.
--
-- teams + team_members (mig 081) stay as-is — they were the right
-- abstraction. race_registrations.team_id references them.
--
-- The mig 081 columns on event_types and bookings are NOT dropped
-- in this migration — codebase convention (see "Deprecated columns
-- kept on disk" in CLAUDE.md) is to deprecate via comment, stop
-- reading them in code, then drop in a follow-up cleanup migration
-- once we're confident the new path is bedded in.
-- ============================================================

BEGIN;

-- ─── race_events ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS race_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id              UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  description              TEXT,
  -- The day the race actually runs. Single date in v1; multi-day
  -- events can be modelled as separate race_events with shared
  -- branding when that becomes a real need.
  race_date                DATE NOT NULL,
  -- First-team start time. Operator-display only in v1; race-day
  -- control UI uses race_registrations.race_started_at as the
  -- timing source. Future heats/waves will hang off here.
  start_time               TIME,
  -- Registration window. NULL = open from creation; NULL = open
  -- right up to race_date. The public signup endpoint enforces
  -- both bounds. Operators can soft-extend by editing.
  registration_opens_at    TIMESTAMPTZ,
  registration_closes_at   TIMESTAMPTZ,
  -- NULL = unlimited. Soft-enforced (warning) in v1, hard-enforce
  -- via UNIQUE (race_event_id, team_id) is the wrong shape; capacity
  -- check happens at signup time as a count vs. configured value.
  capacity                 INT,
  allowed_team_sizes       INT[] NOT NULL DEFAULT ARRAY[1, 2, 4],
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, slug)
);

COMMENT ON TABLE race_events IS
  'Standalone race occurrences (Hyrox sims, etc). Replaces the merged event_types.is_timed_event approach from mig 081 — races are conceptually different from booking events (one date, capacity-bounded, team-first signup, no calendar slot picking) so they deserve their own table and URL space.';

COMMENT ON COLUMN race_events.slug IS
  'URL-safe identifier — public signup page lives at /race/[slug]. UNIQUE per location so two locations can both have a "summer-hyrox-sim" without colliding.';

COMMENT ON COLUMN race_events.allowed_team_sizes IS
  'Team sizes the public signup form will offer (e.g. {1,2,4}). The form shows N−1 additional name+email pairs for any size > 1. Server-side enforcement at signup time.';

CREATE INDEX IF NOT EXISTS idx_race_events_location ON race_events (location_id);
CREATE INDEX IF NOT EXISTS idx_race_events_active ON race_events (location_id, active, race_date) WHERE active;

ALTER TABLE race_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS race_events_location_scoped ON race_events;
CREATE POLICY race_events_location_scoped ON race_events
  FOR ALL
  TO authenticated
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));

CREATE OR REPLACE FUNCTION private.touch_race_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS race_events_touch_updated_at ON race_events;
CREATE TRIGGER race_events_touch_updated_at
  BEFORE UPDATE ON race_events
  FOR EACH ROW EXECUTE FUNCTION private.touch_race_events_updated_at();

-- ─── race_registrations ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS race_registrations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_event_id       UUID NOT NULL REFERENCES race_events(id) ON DELETE CASCADE,
  team_id             UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- Captain — the person who filled out the signup form. Always
  -- set. Their contact row is created by a trigger or by the
  -- signup route's contact upsert.
  contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'confirmed',
  -- Race timing — set by the race-day control UI. Pure append-only
  -- data; the race-reset route is the only path that nulls them.
  race_started_at     TIMESTAMPTZ,
  race_finished_at    TIMESTAMPTZ,
  registered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT race_registrations_status_check CHECK (status IN ('confirmed', 'cancelled', 'no_show')),
  -- One team can only be registered once per race event. (A team
  -- competing twice would create operator confusion at the
  -- start/finish line and is not a real use-case for v1.)
  UNIQUE (race_event_id, team_id)
);

COMMENT ON TABLE race_registrations IS
  'A team registered for a race event. Replaces the bookings.race_started/finished_at pattern from mig 081. One row per (race_event, team). Race timing lives here — race-day control UI starts/finishes/resets these.';

CREATE INDEX IF NOT EXISTS idx_race_registrations_event ON race_registrations (race_event_id);
CREATE INDEX IF NOT EXISTS idx_race_registrations_team ON race_registrations (team_id);
-- Powers the "active teams" query the race-day UI polls every 2s.
CREATE INDEX IF NOT EXISTS idx_race_registrations_active
  ON race_registrations (race_event_id, race_started_at)
  WHERE race_started_at IS NOT NULL AND race_finished_at IS NULL;

ALTER TABLE race_registrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS race_registrations_location_scoped ON race_registrations;
CREATE POLICY race_registrations_location_scoped ON race_registrations
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.race_events re
      WHERE re.id = race_registrations.race_event_id
        AND private.auth_is_in_location(re.location_id)
    )
  )
  WITH CHECK (
    private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.race_events re
      WHERE re.id = race_registrations.race_event_id
        AND private.auth_is_in_location(re.location_id)
    )
  );

CREATE OR REPLACE FUNCTION private.touch_race_registrations_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS race_registrations_touch_updated_at ON race_registrations;
CREATE TRIGGER race_registrations_touch_updated_at
  BEFORE UPDATE ON race_registrations
  FOR EACH ROW EXECUTE FUNCTION private.touch_race_registrations_updated_at();

-- ─── deprecate mig 081 columns ───────────────────────────────────
-- Per the codebase convention (CLAUDE.md "Deprecated columns kept on
-- disk"): leave the columns in place, comment-mark deprecated, stop
-- reading them in app code. A follow-up cleanup migration drops them
-- once the new path is bedded in.

COMMENT ON COLUMN event_types.is_timed_event IS
  'DEPRECATED (mig 082) — replaced by standalone race_events table. Field still exists for back-compat but app code no longer reads it. Drop in a follow-up cleanup migration.';

COMMENT ON COLUMN event_types.allowed_team_sizes IS
  'DEPRECATED (mig 082) — moved to race_events.allowed_team_sizes. Drop in a follow-up cleanup.';

COMMENT ON COLUMN bookings.team_id IS
  'DEPRECATED (mig 082) — race teams now live on race_registrations, not bookings. Field still exists for back-compat but app code no longer reads it.';

COMMENT ON COLUMN bookings.race_started_at IS
  'DEPRECATED (mig 082) — race timing now lives on race_registrations.race_started_at. Drop in a follow-up cleanup.';

COMMENT ON COLUMN bookings.race_finished_at IS
  'DEPRECATED (mig 082) — race timing now lives on race_registrations.race_finished_at.';

COMMIT;
