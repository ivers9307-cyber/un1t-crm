-- 823 — HOSTPAGE.2: a host page that sells, and post-event ratings.
--
-- WHY. /h/<slug> listed upcoming events and a signup form and nothing else:
-- no "who we are", no photos, nothing anyone said, no record of past events,
-- and no way for an attendee to rate an event afterwards. See
-- docs/superpowers/specs/2026-11-08-host-event-features-design.md § 6.
--
-- WHAT.
--   (1) event_hosts: about_text (≤2000, host-written), photos (jsonb list of
--       ≤12 { url, caption ≤120 }, uploaded through POST
--       /api/host/list-page/photos into the branding bucket under
--       host-photos/<host id>/), testimonials (jsonb list of ≤6 { quote ≤400,
--       author ≤80 }, host-written), show_past_events and show_ratings
--       (toggles for the two derived sections). Lengths and shapes are
--       enforced by the Zod schemas in src/lib/host-page-extras.js at the
--       one route that writes them; the public page re-validates on read and
--       drops an invalid entry rather than failing.
--   (2) race_events.rating_email_subject / rating_email_intro: operator copy
--       for the "How was <event>?" request (NULL = default), read by
--       resolveEventEmail({ kind: 'rating' }).
--   (3) public.event_ratings: one rating per registration (UNIQUE), 1–5 with
--       an optional comment ≤600, is_public (the host can hide one), the
--       host_id denormalised for the public summary's read. contact_id is
--       ON DELETE SET NULL so a GDPR erasure keeps the number and drops the
--       person.
--   (4) public.event_rating_requests: the send-once claim for the request
--       email (one per registration, ever), written by the rating-request
--       arm of the hourly event-reminders cron (src/lib/event-rating-requests.js).
--
-- grant: none — event_hosts, race_events and race_registrations have no
-- client privilege; the two new tables are service role only (RLS on, no
-- policy, revoked from anon/authenticated: mig 677's default stated
-- explicitly). Safe to apply before the code deploys: nothing reads any of
-- it until then.

alter table public.event_hosts
  add column if not exists about_text text,
  add column if not exists photos jsonb,
  add column if not exists testimonials jsonb,
  add column if not exists show_past_events boolean not null default true,
  add column if not exists show_ratings boolean not null default true;

comment on column public.event_hosts.about_text is 'HOSTPAGE.2 (mig 823): the About section of /h/<slug>; ≤2000 chars, host-written; NULL = no section.';
comment on column public.event_hosts.photos is 'HOSTPAGE.2: jsonb list of ≤12 { url, caption } for the photo grid; files live in the branding bucket under host-photos/<host id>/. Shape: src/lib/host-page-extras.js HostPhotosSchema.';
comment on column public.event_hosts.testimonials is 'HOSTPAGE.2: jsonb list of ≤6 { quote ≤400, author ≤80 }, host-written. Shape: src/lib/host-page-extras.js HostTestimonialsSchema.';
comment on column public.event_hosts.show_past_events is 'HOSTPAGE.2: show the collapsed "Past events" list on /h/<slug>.';
comment on column public.event_hosts.show_ratings is 'HOSTPAGE.2: show the ratings summary (average + newest comments, once ≥3 public ratings) on /h/<slug>.';

alter table public.race_events
  add column if not exists rating_email_subject text,
  add column if not exists rating_email_intro text;

comment on column public.race_events.rating_email_subject is 'HOSTPAGE.2 (mig 823): operator subject for the post-event rating request; NULL = "How was <event>?". Merge tags as the other event emails.';
comment on column public.race_events.rating_email_intro is 'HOSTPAGE.2: operator intro for the rating request; NULL = the default copy in src/lib/event-ratings.js ratingRequestDefaults.';

create table if not exists public.event_ratings (
  id               uuid primary key default gen_random_uuid(),
  race_event_id    uuid not null references public.race_events(id) on delete cascade,
  registration_id  uuid not null unique references public.race_registrations(id) on delete cascade,
  host_id          uuid not null references public.event_hosts(id) on delete cascade,
  contact_id       uuid references public.contacts(id) on delete set null,
  rating           smallint not null check (rating between 1 and 5),
  comment          text check (comment is null or char_length(comment) <= 600),
  is_public        boolean not null default true,
  created_at       timestamptz not null default now()
);

create index if not exists event_ratings_host_public_idx on public.event_ratings (host_id, is_public, created_at desc);
create index if not exists event_ratings_event_idx on public.event_ratings (race_event_id);

alter table public.event_ratings enable row level security;
revoke all on public.event_ratings from anon, authenticated;

comment on table public.event_ratings is
  'HOSTPAGE.2 (mig 823): one post-event rating per registration (1–5 + optional comment ≤600), written by the public /event/rate/<token> page; the host hides one with is_public=false. Service role only.';

create table if not exists public.event_rating_requests (
  registration_id  uuid primary key references public.race_registrations(id) on delete cascade,
  race_event_id    uuid not null references public.race_events(id) on delete cascade,
  sent_at          timestamptz not null default now()
);

create index if not exists event_rating_requests_event_idx on public.event_rating_requests (race_event_id);

alter table public.event_rating_requests enable row level security;
revoke all on public.event_rating_requests from anon, authenticated;

comment on table public.event_rating_requests is
  'HOSTPAGE.2 (mig 823): send-once claim for the "How was <event>?" email, one per registration ever, claimed BEFORE the send by the rating-request arm of /api/cron/event-reminders. Service role only.';
