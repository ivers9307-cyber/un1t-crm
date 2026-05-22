-- 198_churn_radar_snapshots.sql
--
-- RADAR-TREND.1 — weekly point-in-time rollup of the churn radar
-- summary, so the operator sees whether things are getting better or
-- worse — not just a snapshot count with no context.
--
-- /api/cron/churn-radar-snapshot writes one row per active location
-- every Monday. The radar then compares the live summary against the
-- most recent snapshot to show week-over-week deltas on the summary
-- cards ("Active base 268, down 4 since last week").
--
-- Counts only — the same headline metrics radarSummary already
-- computes. No member-level data: this is a pure aggregate trend
-- table, cheap to write and to read.

begin;

create table if not exists public.churn_radar_snapshots (
  id                     uuid primary key default gen_random_uuid(),
  location_id            uuid not null references public.locations(id) on delete cascade,
  captured_at            timestamptz not null default now(),
  active_base            integer not null default 0,
  at_risk                integer not null default 0,
  high_risk              integer not null default 0,
  overdue                integer not null default 0,
  paused                 integer not null default 0,
  quarantine             integer not null default 0,
  revenue_at_risk_cents  bigint  not null default 0,
  overdue_value_cents    bigint  not null default 0
);

-- The radar reads "latest snapshot for this location" on every load.
create index if not exists idx_churn_radar_snapshots_location
  on public.churn_radar_snapshots (location_id, captured_at desc);

alter table public.churn_radar_snapshots enable row level security;

-- Staff at the location can read snapshots — they drive the
-- week-over-week deltas shown on the radar summary cards.
create policy "Staff can view churn radar snapshots"
  on public.churn_radar_snapshots for select to public
  using (private.auth_is_in_location(location_id));

-- Writes are service-role only — the weekly cron inserts. No insert
-- policy for authenticated users.

comment on table public.churn_radar_snapshots is
  'Weekly point-in-time rollup of the churn radar summary per location. Drives week-over-week trend deltas on the radar cards. RADAR-TREND.1.';

-- Seed the cron heartbeat row. stampHeartbeat() is UPDATE-only, so
-- the row must pre-exist before the first run (the "silent no-op"
-- trap — same pattern as mig 174). Weekly cadence: 7-day interval,
-- 2-day grace to cover a missed Monday run.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values
  ('churn-radar-snapshot', 604800, 172800,
   'RADAR-TREND.1 — weekly (Mon 06:00 UTC) point-in-time snapshot of the churn radar summary per location. 2-day grace covers a missed Monday run.')
on conflict (name) do nothing;

commit;
