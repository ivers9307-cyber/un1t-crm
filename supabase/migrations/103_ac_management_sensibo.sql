-- AC management via Sensibo. Operator config + session log.
-- See app code: src/lib/sensibo.js + /api/studio-management/ac/*
-- + /api/cron/ac-auto-off + AcControlPanel UI.
--
-- Applied via Supabase MCP on 2026-05-06.

create table if not exists public.ac_sessions (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  sensibo_pod_id text not null,
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  auto_off_at timestamptz,
  status text not null default 'on'
    check (status in ('on', 'auto_off', 'manual_off', 'extended', 'failed')),
  ended_at timestamptz,
  ended_by uuid references public.profiles(id) on delete set null,
  sensibo_state_snapshot jsonb,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists ac_sessions_touch on public.ac_sessions;
create trigger ac_sessions_touch
  before update on public.ac_sessions
  for each row execute function public.update_updated_at();

create index if not exists ac_sessions_active_idx
  on public.ac_sessions (location_id, started_at desc)
  where status in ('on', 'extended');

create index if not exists ac_sessions_auto_off_idx
  on public.ac_sessions (auto_off_at)
  where status in ('on', 'extended') and auto_off_at is not null;

alter table public.locations
  add column if not exists sensibo_api_key text,
  add column if not exists sensibo_pod_id text,
  add column if not exists ac_default_mode text default 'cool'
    check (ac_default_mode is null or ac_default_mode in ('cool', 'heat', 'auto', 'fan', 'dry')),
  add column if not exists ac_default_temp int default 18
    check (ac_default_temp is null or (ac_default_temp >= 16 and ac_default_temp <= 30)),
  add column if not exists ac_default_fan text default 'high'
    check (ac_default_fan is null or ac_default_fan in ('auto', 'low', 'medium', 'high', 'quiet', 'strong')),
  add column if not exists ac_session_minutes int default 90
    check (ac_session_minutes is null or (ac_session_minutes >= 5 and ac_session_minutes <= 720));

comment on column public.locations.sensibo_api_key is
  'Per-location Sensibo API key. Plaintext OK — controls AC only, no financial / PII consequences if leaked.';
comment on column public.locations.sensibo_pod_id is
  'The Sensibo pod assigned to this studio. One pod per location for now.';
comment on table public.ac_sessions is
  'AC turn-on events with auto-off timer. Cron at /api/cron/ac-auto-off sweeps expired rows.';
