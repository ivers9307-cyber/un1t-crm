-- 306: Apple-Health workout detail on heart_rate_sessions.
-- Nullable; populated only for source='apple_health' rows by the IB2 mapper.
-- BLE / participation sessions leave these null.
ALTER TABLE heart_rate_sessions
  ADD COLUMN IF NOT EXISTS workout_type        text,
  ADD COLUMN IF NOT EXISTS calories_kcal       numeric,
  ADD COLUMN IF NOT EXISTS distance_meters     numeric,
  ADD COLUMN IF NOT EXISTS avg_pace_sec_per_km numeric;

COMMENT ON COLUMN heart_rate_sessions.workout_type IS
  'OW/Apple workout type (e.g. running, cycling, functional_strength_training); apple_health sessions only (mig 306)';
