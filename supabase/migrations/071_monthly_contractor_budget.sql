-- 071 — Roster v2 phase 4: monthly contractor budget per location.
--
-- Per the locked spec (CLAUDE.md "Roster v2 — locked decisions"):
--   - FTE is sunk cost, doesn't count against the budget.
--   - The euro budget is a CONTRACTOR-spend ceiling only.
--   - One field per location, not two.
--
-- Nullable on purpose: a null budget means "not configured", and
-- the UI shows the spend total without an over/under chip. A
-- NOT NULL default 0 would falsely flag every new location as
-- 100% over budget on day one.
--
-- Phase 5 will add the publish/approval flow that hard-gates on
-- budget; phase 4 is read-only / advisory.

alter table public.locations
  add column if not exists monthly_contractor_budget_eur numeric;

alter table public.locations
  drop constraint if exists locations_monthly_contractor_budget_check;
alter table public.locations
  add constraint locations_monthly_contractor_budget_check
  check (monthly_contractor_budget_eur is null or monthly_contractor_budget_eur >= 0);

comment on column public.locations.monthly_contractor_budget_eur is
  'Roster v2 phase 4. Monthly euro ceiling for contractor labour at this location. FTE shifts are sunk cost and do not count against this. Null = budget not configured (read-only summary, no over/under flag).';
