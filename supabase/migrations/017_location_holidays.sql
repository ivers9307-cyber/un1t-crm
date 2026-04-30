-- ============================================================
-- 017: Per-location custom holidays
--
-- Location-specific closures, observances, or relabelled statutory
-- holidays. The static Irish public holiday list lives in
-- src/lib/bank-holidays.js and is merged with this table at request
-- time — the table only stores OVERRIDES and ADDITIONS.
--
-- Examples:
--   - Christmas Eve closure ("Closed from 14:00")
--   - Good Friday — not a statutory holiday but many gyms close
--   - Local festival days (St Patrick's Festival multi-day, etc.)
-- ============================================================

CREATE TABLE location_holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  UNIQUE (location_id, date)
);

CREATE INDEX idx_location_holidays_location_date
  ON location_holidays (location_id, date);

-- RLS — location-scoped, mirroring the pattern from migration 014.
ALTER TABLE location_holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY location_holidays_location_scoped ON location_holidays
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

COMMENT ON TABLE location_holidays IS
  'Custom per-location holidays / closures. Merged with the static '
  'Irish public holiday list (src/lib/bank-holidays.js) when rendering '
  'the schedule calendar. Same-date custom entry overrides the static '
  'name (e.g. relabel a statutory holiday as "Closed all day").';
