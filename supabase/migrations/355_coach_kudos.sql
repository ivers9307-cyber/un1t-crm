-- 355_coach_kudos.sql — COACH KUDOS
--
-- Staff-authored "kudos" (a short congratulatory note + optional emoji) sent
-- to a member. The member reads their own kudos in the champ app; staff write
-- them from the CRM contact profile / post-class HR session view.
--
-- Mirrors the RLS/grant/index conventions of 272_consultations.sql:
--   • FK to contacts ON DELETE CASCADE (kudos die with the member row)
--   • sender_profile_id / session_id ON DELETE SET NULL (survive deletion)
--   • sender_name denormalised at send time so it survives profile deletion
--     AND is readable by a member whose `authenticated` role has no grant on
--     public.profiles (the mobile-profiles-embed 500 trap).
--   • RLS ENABLED with a staff FOR ALL in-location policy (authenticated) and
--     a member SELECT-own policy (public via private.auth_contact_id()).
--     NO member INSERT/UPDATE/DELETE — mark-seen is a champ-app service-role
--     route; members never write here directly.

create table public.coach_kudos (
  id                 uuid primary key default gen_random_uuid(),
  contact_id         uuid not null references public.contacts(id) on delete cascade,          -- recipient member
  location_id        uuid not null,
  sender_profile_id  uuid references public.profiles(id) on delete set null,                  -- staff sender
  sender_name        text not null,                                                            -- denormalised profiles.full_name at send time
  message            text not null,
  emoji              text,
  session_id         uuid references public.heart_rate_sessions(id) on delete set null,        -- optional: kudo tied to a specific class
  created_at         timestamptz not null default now(),
  seen_at            timestamptz,
  constraint coach_kudos_message_len check (char_length(message) between 1 and 500),
  constraint coach_kudos_emoji_len   check (emoji is null or char_length(emoji) <= 8)
);

create index idx_coach_kudos_contact on public.coach_kudos(contact_id, created_at desc);

alter table public.coach_kudos enable row level security;

-- Staff: full access to kudos in a location they belong to (both USING + WITH CHECK).
create policy coach_kudos_loc on public.coach_kudos for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));

-- Member: read own kudos only. No INSERT/UPDATE/DELETE — seen_at is stamped by
-- a champ-app service-role route, never by the member's authenticated session.
create policy coach_kudos_self on public.coach_kudos for select to public
  using (contact_id = private.auth_contact_id());
