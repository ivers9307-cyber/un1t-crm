-- 276_location_automations.sql — AUTOMATIONS hub config.
-- One row per (location, automation_key). Absent row = disabled
-- (opt-in; never silently auto-enabled). config jsonb future-proofs
-- per-automation options. Staff-in-location read; writes are
-- service-role only (the PUT /api/automations/[key] route).
create table public.location_automations (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  automation_key text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  unique (location_id, automation_key)
);
create index idx_location_automations_loc on public.location_automations(location_id);

alter table public.location_automations enable row level security;

create policy location_automations_loc on public.location_automations for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));
