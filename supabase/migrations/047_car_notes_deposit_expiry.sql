-- Two pieces:
--   1. Per-car notes table — operator-typed and system-generated
--      entries. Every issue of a deposit link drops a system note
--      with the URL so operators can copy / re-share manually.
--   2. Deposit link 24h expiry. Each call to issue-deposit-link
--      rotates the token AND sets a fresh expires_at = NOW()+24h.
--      Public endpoints reject expired or rotated tokens.

-- ─── deposit token expiry ─────────────────────────────────────────

ALTER TABLE cars
  ADD COLUMN IF NOT EXISTS deposit_token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN cars.deposit_token_expires_at IS
  'Expiry stamp for deposit_token (24h after the last issue). Public endpoints reject lookups after this. NULL = no expiry set yet (e.g. legacy rows from before mig 047).';

-- ─── car_notes ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS car_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id      UUID NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  -- Denormalised for RLS — checking the parent car's location on
  -- every SELECT would be a subquery; copy it on insert and we get a
  -- cheap eq on the index.
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  -- 'manual'  — typed by an operator
  -- 'system'  — auto-generated (e.g. deposit link issued)
  kind        TEXT NOT NULL DEFAULT 'manual',
  created_by  UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT car_notes_kind_check CHECK (kind IN ('manual', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_car_notes_car
  ON car_notes (car_id, created_at DESC);

ALTER TABLE car_notes ENABLE ROW LEVEL SECURITY;

-- Same per-location pattern used elsewhere (cars, segments, etc.)
DROP POLICY IF EXISTS car_notes_select ON car_notes;
CREATE POLICY car_notes_select ON car_notes
  FOR SELECT
  USING (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

DROP POLICY IF EXISTS car_notes_insert ON car_notes;
CREATE POLICY car_notes_insert ON car_notes
  FOR INSERT
  WITH CHECK (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

DROP POLICY IF EXISTS car_notes_delete ON car_notes;
CREATE POLICY car_notes_delete ON car_notes
  FOR DELETE
  USING (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

COMMENT ON TABLE car_notes IS
  'Per-car notes. kind=manual for operator-typed entries; kind=system for auto-generated (e.g. deposit link issued).';
