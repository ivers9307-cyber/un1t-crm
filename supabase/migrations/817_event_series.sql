-- 817 — HOSTSERIES.1: event series (one public page, many dates).
--
-- WHY. A host running the same workshop every month re-typed the event each
-- time and had a different link for every date. A series groups those dates:
-- the host duplicates an event onto a list of dates and shares ONE link
-- (/event/series/<slug>) that lists every published upcoming date. See
-- docs/superpowers/specs/2026-11-08-host-event-features-design.md § 1.
--
-- WHAT.
--   (1) public.event_series: the group. host_id is the host that owns it
--       (NULL for a staff-made series), location_id its studio (a host's
--       anchor location), slug the public page's address (unique, derived
--       from the name), headline/blurb the operator-editable copy of that
--       page (NULL = defaults: the name, "Pick a date").
--   (2) race_events.series_id: the series a date belongs to. A deleted series
--       leaves its dates in place with series_id NULL (nothing about a booked
--       event depends on the group).
--
-- Service role only: no client grant, RLS on with no policy (mig 677's
-- default stated explicitly). race_events.series_id is readable wherever
-- race_events already is (it holds no secret). Safe to apply before the code
-- deploys: nothing reads either until then.

create table if not exists public.event_series (
  id           uuid primary key default gen_random_uuid(),
  host_id      uuid references public.event_hosts(id) on delete cascade,
  location_id  uuid not null references public.locations(id) on delete cascade,
  name         text not null,
  slug         text not null unique,
  headline     text,
  blurb        text,
  created_at   timestamptz not null default now()
);

create index if not exists event_series_host_idx on public.event_series (host_id);

alter table public.event_series enable row level security;
revoke all on public.event_series from anon, authenticated;

comment on table public.event_series is
  'HOSTSERIES.1 (mig 817): a group of event dates sharing one public page (/event/series/<slug>). Service role only.';
comment on column public.event_series.headline is 'HOSTSERIES.1: the series page headline; NULL = the series name.';
comment on column public.event_series.blurb is 'HOSTSERIES.1: the series page blurb; NULL = "Pick a date".';

alter table public.race_events
  add column if not exists series_id uuid references public.event_series(id) on delete set null;

create index if not exists race_events_series_idx on public.race_events (series_id) where series_id is not null;

comment on column public.race_events.series_id is
  'HOSTSERIES.1 (mig 817): the series this date belongs to; NULL = none.';
