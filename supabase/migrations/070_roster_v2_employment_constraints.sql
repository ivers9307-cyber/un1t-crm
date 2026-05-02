-- 070 — Roster v2 phase 3: tighten employment-type constraints.
--
-- The `profiles` table already has the fields we need:
--   employment_type  text default 'fte' (nullable, no enum)
--   contracted_hours_per_week numeric default 40 (nullable)
--   hourly_rate      numeric (nullable)
--   overtime_rate    numeric (nullable)
--   annual_salary    numeric (nullable)
--
-- These were added in an earlier pass for the existing payroll
-- cost calc. The StaffForm UI + /api/staff routes already let
-- owner+master edit them — so the bulk of phase 3 was already
-- shipped before Roster v2 even started.
--
-- This migration just adds the missing safety net: a CHECK
-- constraint enforcing employment_type ∈ {'fte','contractor'}
-- and a NOT NULL default. Phase 4's cost calculator will hard-
-- gate on these values, so we want garbage-in to fail at the
-- DB layer rather than producing silent NaN's downstream.

-- ============================================================
-- 1. Backfill any rows that somehow ended up NULL.
-- (Live data is clean today — 0 NULLs — but make this safe to
-- replay against any environment.)
-- ============================================================
update public.profiles
   set employment_type = 'fte'
 where employment_type is null;

-- ============================================================
-- 2. Enum + NOT NULL.
-- ============================================================
alter table public.profiles
  drop constraint if exists profiles_employment_type_check;

alter table public.profiles
  add constraint profiles_employment_type_check
  check (employment_type in ('fte', 'contractor'));

alter table public.profiles
  alter column employment_type set not null,
  alter column employment_type set default 'fte';

comment on column public.profiles.employment_type is
  'fte = salaried employee, sunk cost vs the budget. contractor = per-hour, counts against monthly_contractor_budget_eur (mig 071).';

-- ============================================================
-- 3. Data completeness — surface, not enforce.
-- We do NOT make hourly_rate / contracted_hours_per_week NOT NULL
-- because partial profiles are real (a coach mid-onboarding
-- shouldn't block roster building). Phase 3.5 / phase 4 will
-- show a manager-facing warning chip listing staff with missing
-- pay data so the operator can fix it before the budget panel
-- tries to cost them.
-- ============================================================
