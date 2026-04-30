-- ============================================================
-- 016: Overtime rate on FTE profiles
--
-- Adds an optional explicit overtime hourly rate. Applies to FTE only
-- (contractors are paid hourly_rate regardless of total hours). When
-- NULL, overtime hours are paid at the regular implicit hourly rate
-- (annual_salary / 52 / contracted_hours_per_week) — no premium.
--
-- Owner-only field, edited via /api/staff/[id] PUT and the staff form.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS overtime_rate NUMERIC(8,2);

COMMENT ON COLUMN profiles.overtime_rate IS
  'FTE only. Hourly rate paid for hours scheduled above contracted_hours_per_week '
  'in a Mon-Sun week. NULL means no premium — overtime hours pay at the regular '
  'implicit hourly rate.';
