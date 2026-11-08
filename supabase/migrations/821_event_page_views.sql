-- 821 — HOSTSTATS.1: signup analytics — page views and registration attribution.
--
-- WHY. A host could see who booked but not how many people LOOKED, where
-- they came from, or whether the host's own email drove the bookings. See
-- docs/superpowers/specs/2026-11-08-host-event-features-design.md § 5.
--
-- WHAT.
--   (1) public.event_page_views: one row per (event, visitor session, day),
--       written by POST /api/public/events/[slug]/view when the signup
--       widget mounts. session_id is a random per-tab id the browser keeps
--       in sessionStorage (no cookie, no account); `source` is the one
--       derived word (host_email | the utm_source | a referrer label or host
--       | direct); utm_campaign / utm_content / referrer_host are the
--       sanitised raw signals. A second view by the same session on the same
--       day hits the unique key and is not counted twice. Rows older than
--       180 days are purged by the purge-event-page-views arm (mig 822).
--   (2) race_registrations.attribution: the same sanitised attribution the
--       registration arrived with ({ session_id, source, utm_*,
--       host_campaign_id, referrer_host }), so the stats join views to
--       bookings by `source`.
--
-- grant: none — event_page_views is service role only (no client grant, RLS
-- on with no policy: mig 677's default stated explicitly); race_registrations
-- has no client privilege (mig 682), so the new column needs no grant
-- decision. Safe to apply before the code deploys: nothing reads either
-- until then.

create table if not exists public.event_page_views (
  id             uuid primary key default gen_random_uuid(),
  race_event_id  uuid not null references public.race_events(id) on delete cascade,
  session_id     text not null,
  source         text not null default 'direct',
  utm_campaign   text,
  utm_content    text,
  referrer_host  text,
  day            date not null,
  created_at     timestamptz not null default now(),
  unique (race_event_id, session_id, day)
);

create index if not exists event_page_views_event_day_idx on public.event_page_views (race_event_id, day);
-- The retention purge reads the oldest rows first.
create index if not exists event_page_views_created_idx on public.event_page_views (created_at);

alter table public.event_page_views enable row level security;
revoke all on public.event_page_views from anon, authenticated;

comment on table public.event_page_views is
  'HOSTSTATS.1 (mig 821): one row per (event, visitor session, day) from the public signup page. No cookie: session_id is a per-tab random id. Service role only; purged after 180 days.';
comment on column public.event_page_views.source is
  'HOSTSTATS.1: host_email (a host campaign link, hc=), else the utm_source, else the referrer''s known label or host, else direct. Derived by src/lib/event-attribution.js sourceOf().';

alter table public.race_registrations
  add column if not exists attribution jsonb;
comment on column public.race_registrations.attribution is
  'HOSTSTATS.1 (mig 821): the sanitised attribution the registration arrived with ({ session_id, source, utm_source, utm_medium, utm_campaign, utm_content, host_campaign_id, referrer_host }); NULL for staff-added and pre-feature entries. Written only by the public register route.';
