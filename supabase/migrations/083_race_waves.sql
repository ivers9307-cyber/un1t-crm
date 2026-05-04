-- ============================================================
-- 083: Race waves — multiple start-time slots per race event
--
-- Mig 082 modeled a race as a single occurrence with one start_time
-- and one capacity number. Real Hyrox sims (and similar competitive
-- events) run as multiple waves through the day so the operator can
-- spread teams out across the morning rather than starting 30 teams
-- at once. Waves model that.
--
-- One race_event has 1..N race_waves. Each wave has its own
-- start_time and capacity. race_registrations.wave_id (the column
-- already existed from mig 082 as a placeholder) becomes a real FK
-- to race_waves so each registered team belongs to exactly one wave.
--
-- Backfill: every existing race gets a default wave constructed from
-- its current start_time + capacity. Existing race_registrations
-- (none in production yet at this point but defensive) point at that
-- default wave. After this migration, race_events.start_time and
-- race_events.capacity are DEPRECATED — wave-level data is the new
-- source of truth.
-- ============================================================

BEGIN;

-- ─── race_waves ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS race_waves (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_event_id   UUID NOT NULL REFERENCES race_events(id) ON DELETE CASCADE,
  start_time      TIME NOT NULL,
  capacity        INT,
  -- Optional human label ("Morning", "Elite Wave"). NULL = the UI
  -- falls back to displaying just the start time.
  label           TEXT,
  -- Sort order — falls back to start_time if all rows share 0.
  display_order   INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A race can't have two waves at the same start_time. Operators
  -- distinguishing two simultaneous waves at the same start are
  -- modeling something the data doesn't capture — likely they want
  -- separate races, or the label field if it's purely cosmetic.
  UNIQUE (race_event_id, start_time)
);

COMMENT ON TABLE race_waves IS
  'Multiple start-time slots per race event. Replaces race_events.start_time + race_events.capacity (now DEPRECATED) — wave-level data is the new source of truth. Public signup widget shows a wave picker; race-day control UI tags each registration with its wave badge.';

CREATE INDEX IF NOT EXISTS idx_race_waves_event ON race_waves (race_event_id, start_time);

ALTER TABLE race_waves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS race_waves_location_scoped ON race_waves;
CREATE POLICY race_waves_location_scoped ON race_waves
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.race_events re
      WHERE re.id = race_waves.race_event_id
        AND private.auth_is_in_location(re.location_id)
    )
  )
  WITH CHECK (
    private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.race_events re
      WHERE re.id = race_waves.race_event_id
        AND private.auth_is_in_location(re.location_id)
    )
  );

CREATE OR REPLACE FUNCTION private.touch_race_waves_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS race_waves_touch_updated_at ON race_waves;
CREATE TRIGGER race_waves_touch_updated_at
  BEFORE UPDATE ON race_waves
  FOR EACH ROW EXECUTE FUNCTION private.touch_race_waves_updated_at();

-- ─── backfill: one default wave per existing race ────────────────
-- For every race already in the DB, materialise the start_time +
-- capacity as a single row in race_waves so existing data keeps
-- working without operator intervention.

INSERT INTO race_waves (race_event_id, start_time, capacity, label, display_order)
SELECT id, COALESCE(start_time, '09:00'), capacity, NULL, 0
  FROM race_events
 WHERE NOT EXISTS (
   SELECT 1 FROM race_waves rw WHERE rw.race_event_id = race_events.id
 );

-- ─── race_registrations.wave_id → real FK ────────────────────────
-- Mig 082's docstring said this column already existed as a
-- placeholder, but in practice the table create didn't include it.
-- Add it here, then backfill, then add the FK.

ALTER TABLE race_registrations
  ADD COLUMN IF NOT EXISTS wave_id UUID;

UPDATE race_registrations rr
   SET wave_id = (SELECT id FROM race_waves rw WHERE rw.race_event_id = rr.race_event_id LIMIT 1)
 WHERE wave_id IS NULL;

ALTER TABLE race_registrations
  DROP CONSTRAINT IF EXISTS race_registrations_wave_id_fkey;
ALTER TABLE race_registrations
  ADD CONSTRAINT race_registrations_wave_id_fkey
  FOREIGN KEY (wave_id) REFERENCES race_waves(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_race_registrations_wave ON race_registrations (wave_id) WHERE wave_id IS NOT NULL;

COMMENT ON COLUMN race_registrations.wave_id IS
  'Which wave the team is registered for (mig 083). NOT NULL in app code (the public signup route requires a wave_id and validates it belongs to the parent race) but the column itself stays nullable so a race-event delete can ON DELETE SET NULL the children.';

-- ─── deprecate the race-level start_time + capacity ──────────────

COMMENT ON COLUMN race_events.start_time IS
  'DEPRECATED (mig 083) — replaced by race_waves.start_time per-wave. Field still exists for back-compat but app code no longer reads it. Drop in a follow-up cleanup migration.';

COMMENT ON COLUMN race_events.capacity IS
  'DEPRECATED (mig 083) — replaced by race_waves.capacity per-wave. Total race capacity = sum of wave capacities. Drop in a follow-up cleanup migration.';

COMMIT;
