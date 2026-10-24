-- FINDTEAM.1 — "Find me a team" for race events.
--
-- A solo entrant on a team race registers as a team of one flagged
-- looking_for_team; staff later place them into a team. Three parts:
--   1. race_registrations gains looking_for_team (the open-queue flag) and the
--      placement record: placed_into_registration_id (the team's registration
--      they joined), placed_at, placed_by (the staff member who did it).
--   2. race_registrations.status gains 'placed': a solo registration that has
--      been moved into a team stops being a registration in its own right
--      (nothing to run, nothing to charge twice) but stays on file as history.
--   3. race_events.find_team: the per-event copy and switch for the feature,
--      { enabled, label, blurb, confirmation_paragraph, placed_subject,
--      placed_intro }; null means off / defaults.
--
-- status is now: pending_payment | confirmed | cancelled | no_show | placed.
--
-- race_registrations and race_events have no client privilege (mig 682); this
-- migration grants nothing to anon or authenticated. Every read and write is a
-- service-role route.
--
-- Applied via Supabase MCP against iyvtbjjxdggiadzwwvdj BEFORE the code deploys.

-- column-grant: withheld race_registrations.looking_for_team
-- column-grant: withheld race_registrations.placed_into_registration_id
-- column-grant: withheld race_registrations.placed_at
-- column-grant: withheld race_registrations.placed_by
alter table public.race_registrations
  add column if not exists looking_for_team boolean not null default false,
  add column if not exists placed_into_registration_id uuid references public.race_registrations(id) on delete set null,
  add column if not exists placed_at timestamptz,
  add column if not exists placed_by uuid references public.profiles(id) on delete set null;

-- Mig 084 widened this CHECK to four values; 'placed' makes five.
alter table public.race_registrations
  drop constraint if exists race_registrations_status_check;
alter table public.race_registrations
  add constraint race_registrations_status_check
  check (status in ('pending_payment', 'confirmed', 'cancelled', 'no_show', 'placed'));

-- The staff queue: confirmed solo entrants still looking, per event.
create index if not exists idx_race_registrations_looking
  on public.race_registrations (race_event_id)
  where looking_for_team and status = 'confirmed';

comment on column public.race_registrations.looking_for_team is 'FINDTEAM.1: a solo entrant who asked staff to find them a team. Cleared when they are placed.';
comment on column public.race_registrations.placed_into_registration_id is 'FINDTEAM.1: the team registration this solo entrant was placed into; null until placed (or if that registration is deleted).';
comment on column public.race_registrations.placed_at is 'FINDTEAM.1: when staff placed this entrant into a team.';
comment on column public.race_registrations.placed_by is 'FINDTEAM.1: the staff member who placed this entrant into a team.';
comment on column public.race_registrations.status is 'pending_payment: signup submitted but checkout not yet completed (mig 084). confirmed: paid (or free). cancelled: operator removed. no_show: race day passed without showing. placed: a looking-for-a-team entrant moved into a team (mig 766).';

-- The per-event feature switch and copy. No GRANT: the column is not handed to
-- anon or authenticated, and the public events read goes through the service role.
-- column-grant: withheld race_events.find_team
alter table public.race_events
  add column if not exists find_team jsonb;

comment on column public.race_events.find_team is 'FINDTEAM.1: Find me a team settings { enabled, label, blurb, confirmation_paragraph, placed_subject, placed_intro } (validated by Zod on write); null means off / defaults.';
