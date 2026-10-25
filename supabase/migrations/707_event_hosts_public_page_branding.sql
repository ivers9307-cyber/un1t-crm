-- 707 — HOST-EVENTS-PAGE.1: host-level branding + copy for the public /h/[slug] page.
--
-- WHY. /h/[slug] now lists the host's upcoming events (the public had no
-- page showing all of a host's events; each was reachable only by its own
-- /event/ link). The page carries the HOST's branding, not the studio's.
--
-- WHAT. Four nullable columns on event_hosts, all operator-editable from
-- the host portal (PATCH /api/host/list-page). NULL = default: the page
-- falls back to the hero of the nearest upcoming event that has one, a
-- neutral accent, and built-in wording. Written by the service role only
-- (the host portal route); event_hosts has no client grant. Safe to apply
-- before the code deploys (nothing reads the columns until then).

alter table public.event_hosts
  add column if not exists hero_image_url text,
  add column if not exists accent_hex text,
  add column if not exists events_headline text,
  add column if not exists events_blurb text;

alter table public.event_hosts
  drop constraint if exists event_hosts_accent_hex_check;
alter table public.event_hosts
  add constraint event_hosts_accent_hex_check
  check (accent_hex is null or accent_hex ~ '^#[0-9a-fA-F]{6}$');

comment on column public.event_hosts.hero_image_url is 'HOST-EVENTS-PAGE.1 — hero image for the public /h/[slug] page; NULL = the nearest upcoming event''s hero, else none.';
comment on column public.event_hosts.accent_hex is 'HOST-EVENTS-PAGE.1 — #rrggbb accent for /h/[slug]; NULL = neutral.';
comment on column public.event_hosts.events_headline is 'HOST-EVENTS-PAGE.1 — /h/[slug] events headline; NULL = "Upcoming events".';
comment on column public.event_hosts.events_blurb is 'HOST-EVENTS-PAGE.1 — /h/[slug] events intro; NULL = none.';
