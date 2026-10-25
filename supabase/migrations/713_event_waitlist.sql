-- 713 — EVENT-WAITLIST.1: a waitlist for sold-out events.
--
-- WHY. When every time of an event is full the public page says "Sold out"
-- and the person leaves. When a spot frees (a cancellation, a move, a
-- capacity bump) nobody hears about it. See
-- docs/superpowers/plans/2026-10-09-event-waitlist.md.
--
-- WHAT.
--   (1) event_waitlist: one row per (event, email). Per EVENT, not per time.
--       status: waiting → offered (an offer went out; stays on the list) →
--       claimed (they booked through the claim link) | expired (the event
--       date passed) | removed (staff took them off). A removed or expired
--       row that joins again is reset to waiting by the app (upsert on the
--       unique key), never duplicated.
--   (2) Two operator-editable copy columns on race_events for the offer
--       email (NULL = the built-in default, the mig 385/708/710 pattern).
--   (3) A cron_heartbeats row for /api/cron/event-waitlist-offers (*/10).
--
-- The offer round (src/lib/event-waitlist.js runWaitlistOffers) emails, and
-- WhatsApps when the location has an APPROVED `event_waitlist_offer`
-- template, everyone waiting at once; the first to complete a booking wins.
-- The register route stays the arbiter (its capacity gate). Nothing here
-- holds a place.
--
-- Service role only: no client grant (mig 677 default, stated explicitly),
-- RLS on with no policy. Every read and write is a service-role route.
-- Safe to apply before the code deploys (nothing reads it until then).

create table if not exists public.event_waitlist (
  id              uuid primary key default gen_random_uuid(),
  race_event_id   uuid not null references public.race_events(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  contact_id      uuid references public.contacts(id) on delete set null,
  name            text not null,
  email           text not null,
  phone           text,
  headcount       int not null default 1 check (headcount between 1 and 50),
  status          text not null default 'waiting' check (status in ('waiting','offered','claimed','expired','removed')),
  source          text not null default 'public' check (source in ('public','staff','host','agent')),
  marketing_consent boolean,
  last_offered_at timestamptz,
  offer_count     int not null default 0,
  claimed_registration_id uuid references public.race_registrations(id) on delete set null,
  removed_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (race_event_id, email)
);

create index if not exists event_waitlist_event_status_idx on public.event_waitlist (race_event_id, status);
create index if not exists event_waitlist_status_offered_idx on public.event_waitlist (status, last_offered_at);

drop trigger if exists event_waitlist_updated_at on public.event_waitlist;
create trigger event_waitlist_updated_at
  before update on public.event_waitlist
  for each row execute function public.update_updated_at();

alter table public.event_waitlist enable row level security;
revoke all on public.event_waitlist from anon, authenticated;

comment on table public.event_waitlist is
  'EVENT-WAITLIST.1 (mig 713): people waiting for a place at a sold-out event. One row per (race_event_id, email); per event, not per time. Service role only. The count and the list are staff/host data: never shown to the public.';
comment on column public.event_waitlist.email is 'Lower-cased, trimmed by the app before insert (the unique key).';
comment on column public.event_waitlist.headcount is 'Group size they want (1 for a solo entry). Informational: the register route judges fit when they book.';
comment on column public.event_waitlist.status is 'waiting | offered (an offer went out, still on the list) | claimed (booked via the claim link) | expired (event date passed) | removed (staff).';
comment on column public.event_waitlist.last_offered_at is 'When the last offer went out. The offer round sends at most one offer per row per 24 h.';
comment on column public.event_waitlist.claimed_registration_id is 'The race_registrations row created through this row''s claim link (waitlist_token on the register call).';

alter table public.race_events
  add column if not exists waitlist_email_subject text,
  add column if not exists waitlist_email_intro text;

comment on column public.race_events.waitlist_email_subject is 'EVENT-WAITLIST.1 — subject of the "a spot opened up" offer email; NULL = default.';
comment on column public.race_events.waitlist_email_intro is 'EVENT-WAITLIST.1 — intro copy of the offer email ({{claim_url}} available); NULL = default.';

-- HEARTBEAT. /api/cron/event-waitlist-offers runs */10 and stamps on every
-- run that completed (a run with nothing to offer is healthy and stamps;
-- per-row send failures are counts, never a missed stamp). 600 + 900: one
-- missed tick never pages, two in a row do (25 min), the CLASSSYNCHB.1
-- (mig 644) rule.
--
-- Born healthy (last_ok_at = now()) so it cannot page before the first real
-- tick: that leaves 25 minutes between applying this and the code being
-- live. If the deploy is slower, re-run this insert after it: replaying is
-- safe, it only refreshes the row and re-arms last_ok_at.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at, notes)
values (
  'event-waitlist-offers',
  600,
  900,
  now(),
  'EVENT-WAITLIST.1 (mig 713) — the waitlist offer round, Vercel cron */10 * * * * (src/lib/event-waitlist.js runWaitlistOffers). Stamped at the end of every completed run; per-row email/WhatsApp failures are counts in last_outcome { events, offered, expired, skipped, failed, no_room, claimed, reopened }, so a flaky Postmark does not page. STALE means the route threw or the cron stopped firing for 25 minutes.'
)
on conflict (name) do update
  set last_ok_at = now(),
      expected_interval_seconds = excluded.expected_interval_seconds,
      grace_seconds = excluded.grace_seconds,
      notes = excluded.notes;

do $$
declare e record;
begin
  for e in select * from (values
    ('event-waitlist-offers', 600, 900)
  ) as v(name, interval_s, grace_s) loop
    perform 1 from public.cron_heartbeats h
     where h.name = e.name and h.expected_interval_seconds = e.interval_s and h.grace_seconds = e.grace_s;
    if not found then
      raise exception 'mig 713: cron_heartbeats row % did not end up on % + %', e.name, e.interval_s, e.grace_s;
    end if;
  end loop;
end $$;
