-- 708 — EVENT-MOVE.1: move an event entry to another event.
--
-- WHY. Staff had no way to carry a customer's entry (team, people, payment,
-- history) from one event to another: the only options were cancel-and-rebook
-- (money and QR lost) or a note. See docs/superpowers/specs/
-- 2026-10-08-event-entry-move-design.md.
--
-- WHAT. (1) registration_moves: one row per move, the history behind the
-- "Moved from" chip and the source event's "moved out" footer. (2) Two
-- operator-editable copy columns on race_events for the "your entry has
-- moved" email (NULL = the built-in default, same pattern as mig 385).
-- (3) move_race_registration(): the writes of a move in ONE transaction.
-- Every eligibility rule runs in JS first (src/lib/registration-move.js);
-- the function only writes, and leans on UNIQUE(race_event_id, team_id) as
-- the last line of defence. When the target studio differs from the source
-- studio the team is CLONED into the target studio (teams are unique per
-- studio, and team-member edits are authorised on the team's home studio);
-- the original team row keeps the source event's history.
--
-- Service role only: no client grant on the table, no client EXECUTE on the
-- function (mig 667/677 defaults, stated explicitly). Safe to apply before
-- the code deploys (nothing reads any of it until then).

create table if not exists public.registration_moves (
  id               uuid primary key default gen_random_uuid(),
  registration_id  uuid not null references public.race_registrations(id) on delete cascade,
  from_event_id    uuid references public.race_events(id) on delete set null,
  from_wave_id     uuid references public.race_waves(id) on delete set null,
  to_event_id      uuid references public.race_events(id) on delete set null,
  to_wave_id       uuid references public.race_waves(id) on delete set null,
  from_team_id     uuid references public.teams(id) on delete set null,
  to_team_id       uuid references public.teams(id) on delete set null,
  headcount        int not null default 1,
  price_gap_cents  int not null default 0,
  forced           boolean not null default false,
  actor_type       text not null check (actor_type in ('staff', 'host', 'agent')),
  actor_id         uuid,
  actor_name       text not null default '',
  note             text,
  notified_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists registration_moves_registration_idx on public.registration_moves (registration_id, created_at desc);
create index if not exists registration_moves_from_event_idx on public.registration_moves (from_event_id);
create index if not exists registration_moves_to_event_idx on public.registration_moves (to_event_id);

alter table public.registration_moves enable row level security;
revoke all on public.registration_moves from anon, authenticated;

comment on table public.registration_moves is
  'EVENT-MOVE.1 (mig 708): one row per move of a race_registrations row to another event. Service role only. from_team_id = to_team_id unless the move crossed studios (then to_team_id is the clone).';

alter table public.race_events
  add column if not exists moved_email_subject text,
  add column if not exists moved_email_intro text;

comment on column public.race_events.moved_email_subject is 'EVENT-MOVE.1 — subject of the "your entry has moved" email; NULL = default.';
comment on column public.race_events.moved_email_intro is 'EVENT-MOVE.1 — intro copy of the "your entry has moved" email; NULL = default.';

create or replace function public.move_race_registration(
  p_registration_id uuid,
  p_to_event_id     uuid,
  p_to_wave_id      uuid,
  p_headcount       int,
  p_price_gap_cents int,
  p_forced          boolean,
  p_actor_type      text,
  p_actor_id        uuid,
  p_actor_name      text,
  p_note            text
) returns public.registration_moves
language plpgsql
set search_path = public
as $$
declare
  v_reg        race_registrations%rowtype;
  v_from_loc   uuid;
  v_to_loc     uuid;
  v_team_name  text;
  v_candidate  text;
  v_n          int := 1;
  v_to_team_id uuid;
  v_move       registration_moves;
begin
  select * into v_reg from race_registrations where id = p_registration_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select location_id into v_from_loc from race_events where id = v_reg.race_event_id;
  select location_id into v_to_loc from race_events where id = p_to_event_id;
  if v_to_loc is null then
    raise exception 'target_not_found' using errcode = 'P0002';
  end if;

  v_to_team_id := v_reg.team_id;

  -- Cross-studio: clone the team into the target studio.
  if v_reg.team_id is not null and v_from_loc is distinct from v_to_loc then
    select name into v_team_name from teams where id = v_reg.team_id;
    v_candidate := v_team_name;
    while exists (select 1 from teams where location_id = v_to_loc and name = v_candidate) loop
      v_n := v_n + 1;
      v_candidate := v_team_name || ' (' || v_n || ')';
    end loop;
    insert into teams (location_id, name, size, captain_contact_id, notes)
      select v_to_loc, v_candidate, size, captain_contact_id, notes
      from teams where id = v_reg.team_id
      returning id into v_to_team_id;
    insert into team_members (team_id, contact_id, name, email, role, is_member,
                              member_validation_status, member_contact_id, member_validated_at)
      select v_to_team_id, contact_id, name, email, role, is_member,
             member_validation_status, member_contact_id, member_validated_at
      from team_members where team_id = v_reg.team_id;
  end if;

  update race_registrations
     set race_event_id = p_to_event_id,
         wave_id       = p_to_wave_id,
         team_id       = v_to_team_id,
         updated_at    = now()
   where id = p_registration_id;

  update race_payments
     set race_event_id = p_to_event_id
   where race_registration_id = p_registration_id;

  delete from event_reminder_sends where registration_id = p_registration_id;

  insert into registration_moves (
    registration_id, from_event_id, from_wave_id, to_event_id, to_wave_id,
    from_team_id, to_team_id, headcount, price_gap_cents, forced,
    actor_type, actor_id, actor_name, note
  ) values (
    p_registration_id, v_reg.race_event_id, v_reg.wave_id, p_to_event_id, p_to_wave_id,
    v_reg.team_id, v_to_team_id, coalesce(p_headcount, 1), coalesce(p_price_gap_cents, 0), coalesce(p_forced, false),
    p_actor_type, p_actor_id, coalesce(p_actor_name, ''), nullif(btrim(coalesce(p_note, '')), '')
  ) returning * into v_move;

  return v_move;
end
$$;

revoke execute on function public.move_race_registration(uuid, uuid, uuid, int, int, boolean, text, uuid, text, text)
  from public, anon, authenticated;

comment on function public.move_race_registration(uuid, uuid, uuid, int, int, boolean, text, uuid, text, text) is
  'EVENT-MOVE.1 (mig 708): the writes of an entry move in one transaction. Rules are checked in src/lib/registration-move.js before calling. Service role only.';
