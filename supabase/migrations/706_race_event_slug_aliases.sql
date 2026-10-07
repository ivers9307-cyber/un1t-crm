-- 706 — EVENT-SLUG.1: old event slugs keep resolving after a rename.
--
-- WHY. Event URLs now read as place-date-time (/event/hatch-oct18-1230).
-- Renaming the upcoming events would 404 the slug a host campaign emailed
-- to 164 people on 7 Sep (/event/pride-training-club-4) and any bookmark
-- a registrant kept, so a renamed event keeps its old slugs as aliases
-- and /event/[old-slug] redirects to the live one.
--
-- WHAT. One row per retired slug → the event it belonged to. Written by
-- the service role only (the data fix that renames an event records its
-- old slug here); read by the public /event/[slug] page on a miss, and by
-- `uniqueEventSlug` so a new event can never take a slug that still
-- redirects somewhere. No client grant: anon and authenticated hold
-- nothing (mig 677 default, stated explicitly), RLS on with no policy.
-- Safe to apply before the code deploys (nothing reads it until then).

create table if not exists public.race_event_slug_aliases (
  old_slug      text primary key,
  race_event_id uuid not null references public.race_events(id) on delete cascade,
  created_at    timestamptz not null default now()
);

create index if not exists race_event_slug_aliases_event_idx
  on public.race_event_slug_aliases (race_event_id);

alter table public.race_event_slug_aliases enable row level security;
revoke all on public.race_event_slug_aliases from anon, authenticated;

comment on table public.race_event_slug_aliases is
  'EVENT-SLUG.1 (mig 706): retired race_events slugs → the event they belonged to. /event/[old_slug] redirects to the live slug; uniqueEventSlug() refuses to reuse one. Service role only: no client grant, RLS on with no policy.';
comment on column public.race_event_slug_aliases.old_slug is
  'The slug as it was shared (lowercase kebab, exact match). Must never equal a live race_events.slug — the resolver checks live slugs first, so a collision would silently shadow the alias.';
