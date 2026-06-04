-- MOBILE-LAYOUT Phase 2 — per-(staff, location) personal bottom-bar arrangement.
--
-- Phase 1 (permissions.mobile.layout) lets an admin set each staff member's
-- "allowed" bar-eligible set + a default bar, per location. Phase 2 lets the
-- staff member arrange THEIR bar within that allowed set, from their phone.
-- This table holds that personal arrangement, keyed per (profile, location).
--
-- Written ONLY via PUT /api/mobile/layout (service-role, scoped to the authed
-- user, validated against their allowed∩enabled set). The resolver clamps the
-- stored bar to allowed∩enabled at render time, so the admin's bounds always
-- hold even if the allowed set later narrows. UI arrangement only — RLS stays
-- the security boundary.

create table if not exists public.mobile_bar_prefs (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  bar         text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (profile_id, location_id)
);

alter table public.mobile_bar_prefs enable row level security;

-- Defense-in-depth: a user may read their own prefs. Writes go through the
-- service-role endpoint only (no authenticated INSERT/UPDATE policy). auth.uid()
-- wrapped per the initplan perf convention (PERF.1).
create policy "Users read own bar prefs"
  on public.mobile_bar_prefs
  for select to authenticated
  using (profile_id = (select auth.uid()));

-- Covering index for the location FK (the profile FK leads the PK).
create index if not exists idx_mobile_bar_prefs_location
  on public.mobile_bar_prefs (location_id);
