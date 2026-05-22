-- 201_lead_radar_snapshots.sql
--
-- LEAD-TREND.1 — weekly point-in-time rollup of the Lead Radar
-- summary, so the operator sees whether the funnel and the cleanup
-- backlog are growing or shrinking — not just a bare count.
--
-- /api/cron/lead-radar-snapshot writes one row per active location
-- every Monday. The Lead Radar then compares the live summary against
-- the most recent snapshot to show week-over-week deltas on the
-- summary cards. Counts only — a pure aggregate trend table, the
-- mirror of churn_radar_snapshots (mig 198).

begin;

create table if not exists public.lead_radar_snapshots (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations(id) on delete cascade,
  captured_at   timestamptz not null default now(),
  funnel_total  integer not null default 0,
  attending     integer not null default 0,
  fresh         integer not null default 0,
  cleanup_total integer not null default 0
);

create index if not exists idx_lead_radar_snapshots_location
  on public.lead_radar_snapshots (location_id, captured_at desc);

alter table public.lead_radar_snapshots enable row level security;

-- Staff at the location can read snapshots — they drive the
-- week-over-week deltas shown on the Lead Radar summary cards.
create policy "Staff can view lead radar snapshots"
  on public.lead_radar_snapshots for select to public
  using (private.auth_is_in_location(location_id));

-- Writes are service-role only — the weekly cron inserts.

comment on table public.lead_radar_snapshots is
  'Weekly point-in-time rollup of the Lead Radar summary per location. Drives week-over-week trend deltas. LEAD-TREND.1.';

-- Seed the cron heartbeat row (UPDATE-only stampHeartbeat needs the
-- row to pre-exist — same pattern as mig 198 / 200).
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values
  ('lead-radar-snapshot', 604800, 172800,
   'LEAD-TREND.1 — weekly (Mon 06:30 UTC) point-in-time snapshot of the Lead Radar summary per location. 2-day grace covers a missed Monday run.')
on conflict (name) do nothing;

commit;
