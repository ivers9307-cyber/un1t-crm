-- 870 — TEAMNAMES.1: a team name is unique per EVENT, not per studio.
--
-- WHY. `teams` was UNIQUE (location_id, name) since mig 081, and a team's
-- roster (`team_members`) belongs to the team row. EVENTTEAM.1 (#2391) stopped
-- a signup from taking over a row by typing its name, so a returning captain
-- whose "Rockets" row was entered at an earlier event got a fresh row named
-- "Rockets 2" at the next one: the studio-wide unique name was already taken
-- by their own old team. The owner approved per-event names.
--
-- WHAT.
--   1. `teams.race_event_id` (FK race_events, ON DELETE CASCADE: a team row
--      belongs to its event; the event's registrations already cascade).
--   2. Backfill: a team entered at exactly ONE event belongs to that event.
--      A team entered at several events (reused before #2391) or at none
--      keeps NULL: a legacy, event-less row.
--   3. Guard: abort if existing rows would break either new index.
--   4. Swap the studio-wide UNIQUE (location_id, name) for two partial
--      unique indexes: (race_event_id, name) for event rows, and
--      (location_id, name) for legacy event-less rows.
--   5. Trigger `teams_legacy_name_unique`: an event-less row's name stays
--      unique against EVERY team at its studio (the old rule), raised as
--      23505 like the old constraint. Only code from before this PR writes
--      event-less rows (it never sets race_event_id), so this keeps that code
--      exactly as safe as under the old constraint between this migration and
--      the deploy; the new code always writes race_event_id.
--   6. move_race_registration (mig 708) re-created: a moved entry's event row
--      moves to the target event with it (renamed "Name (2)" only if the name
--      is taken there), and a cross-studio clone belongs to the target event.
--
-- No grants: `teams` stays closed to every client session (mig 682), and the
-- trigger function is service-role only like every new public function
-- (mig 667). CREATE OR REPLACE keeps move_race_registration's ACL; the REVOKE
-- is restated anyway.
--
-- SAFE TO APPLY BEFORE THE CODE DEPLOYS. Old code reads teams by
-- (location_id, name) and finds at most one row, because it never inserts an
-- event-less row whose name is taken at the studio (trigger) and no event row
-- shares a name until the new code writes one. One narrow exception: a
-- CROSS-studio move made between apply and deploy can clone a name that an
-- event row at the target studio already holds; old code then answers "try
-- again" (503) for that one name until the deploy. Apply it first, then
-- deploy: the new code reads and writes race_event_id.

alter table public.teams
  add column if not exists race_event_id uuid references public.race_events(id) on delete cascade;

comment on column public.teams.race_event_id is
  'TEAMNAMES.1 (mig 870): the event this team row belongs to; unique with name. NULL = a legacy row from before mig 870 entered at several events or none, unique with name across its studio (trigger teams_legacy_name_unique).';

comment on table public.teams is
  'Competing teams in timed events. One row per team per event since mig 870 (race_event_id): a returning captain books the same name at each event and each event has its own row and roster (team_members). Legacy event-less rows (race_event_id NULL) keep a studio-wide unique name.';

-- 2. Backfill: a team entered at exactly one event belongs to it.
update public.teams t
   set race_event_id = one.race_event_id
  from (
    select team_id, min(race_event_id::text)::uuid as race_event_id
      from public.race_registrations
     group by team_id
    having count(distinct race_event_id) = 1
  ) one
 where t.id = one.team_id
   and t.race_event_id is null;

-- 3. Guard: refuse if existing data would break the new indexes.
do $$
declare
  v_event_dupes  int;
  v_legacy_dupes int;
begin
  select count(*) into v_event_dupes from (
    select 1 from public.teams where race_event_id is not null
     group by race_event_id, name having count(*) > 1
  ) d;
  select count(*) into v_legacy_dupes from (
    select 1 from public.teams where race_event_id is null
     group by location_id, name having count(*) > 1
  ) d;
  if v_event_dupes > 0 or v_legacy_dupes > 0 then
    raise exception 'mig 870: % event team name(s) and % legacy team name(s) are duplicated; resolve them before applying', v_event_dupes, v_legacy_dupes;
  end if;
end
$$;

-- 4. Swap the studio-wide unique name for per-event uniqueness.
do $$
declare
  v_con text;
begin
  for v_con in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.teams'::regclass
       and c.contype = 'u'
       and (select array_agg(a.attname::text order by a.attname)
              from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)
           = array['location_id', 'name']
  loop
    execute format('alter table public.teams drop constraint %I', v_con);
  end loop;
end
$$;

create unique index if not exists teams_event_name_key
  on public.teams (race_event_id, name) where race_event_id is not null;
create unique index if not exists teams_legacy_location_name_key
  on public.teams (location_id, name) where race_event_id is null;

-- 5. An event-less row's name stays unique across its studio.
create or replace function public.teams_legacy_name_unique()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.race_event_id is null and exists (
    select 1 from teams
     where location_id = new.location_id
       and name = new.name
       and id <> new.id
  ) then
    raise exception 'duplicate key value violates unique constraint "teams_legacy_location_name_key"'
      using errcode = 'unique_violation',
            detail = format('Key (location_id, name)=(%s, %s) already exists.', new.location_id, new.name);
  end if;
  return new;
end
$$;

revoke execute on function public.teams_legacy_name_unique() from public, anon, authenticated;

drop trigger if exists teams_legacy_name_unique on public.teams;
create trigger teams_legacy_name_unique
  before insert or update of name, location_id, race_event_id on public.teams
  for each row execute function public.teams_legacy_name_unique();

comment on function public.teams_legacy_name_unique() is
  'TEAMNAMES.1 (mig 870): an event-less (legacy) team row keeps a name unique against every team at its studio, raised as 23505. Service role only.';

-- 6. A move carries the team's event row with it.
create or replace function public.move_race_registration(
  p_registration_id uuid,
  p_from_event_id   uuid,
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
  v_team_event uuid;
  v_candidate  text;
  v_n          int := 1;
  v_to_team_id uuid;
  v_move       registration_moves;
begin
  select * into v_reg from race_registrations where id = p_registration_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- The JS rules ran on rows read BEFORE this lock. Re-check, under it, the
  -- invariants a concurrent write could have broken since: the entry is
  -- still on the event the caller judged, still live, has not raced or
  -- checked in, and the target wave belongs to the target event. Any of
  -- them failing is 'conflict' (P0003): the caller says "reload and retry".
  if v_reg.race_event_id is distinct from p_from_event_id
     or v_reg.status not in ('confirmed', 'pending_payment')
     or v_reg.race_started_at is not null
     or v_reg.race_finished_at is not null
     or exists (select 1 from race_checkins where race_registration_id = p_registration_id)
     or (p_to_wave_id is not null
         and not exists (select 1 from race_waves where id = p_to_wave_id and race_event_id = p_to_event_id))
  then
    raise exception 'conflict' using errcode = 'P0003';
  end if;
  select location_id into v_from_loc from race_events where id = v_reg.race_event_id;
  select location_id into v_to_loc from race_events where id = p_to_event_id;
  if v_to_loc is null then
    raise exception 'target_not_found' using errcode = 'P0002';
  end if;

  v_to_team_id := v_reg.team_id;

  if v_reg.team_id is not null then
    select name, race_event_id into v_team_name, v_team_event from teams where id = v_reg.team_id for update;
    -- TEAMNAMES.1 — the name the team takes at the target event: its own,
    -- or "Name (2)", "Name (3)", … if a team there already holds it.
    v_candidate := v_team_name;
    -- A legacy event-less row entered at the target holds its name there too.
    while exists (select 1 from teams t
                   where t.name = v_candidate and t.id <> v_reg.team_id
                     and (t.race_event_id = p_to_event_id
                          or (t.race_event_id is null and t.location_id = v_to_loc
                              and exists (select 1 from race_registrations r
                                           where r.team_id = t.id and r.race_event_id = p_to_event_id)))) loop
      v_n := v_n + 1;
      v_candidate := v_team_name || ' (' || v_n || ')';
    end loop;

    if v_from_loc is distinct from v_to_loc then
      -- Cross-studio: clone the team into the target studio and event; the
      -- original row keeps the source event's history.
      insert into teams (location_id, race_event_id, name, size, captain_contact_id, notes)
        select v_to_loc, p_to_event_id, v_candidate, size, captain_contact_id, notes
        from teams where id = v_reg.team_id
        returning id into v_to_team_id;
      insert into team_members (team_id, contact_id, name, email, role, is_member,
                                member_validation_status, member_contact_id, member_validated_at)
        select v_to_team_id, contact_id, name, email, role, is_member,
               member_validation_status, member_contact_id, member_validated_at
        from team_members where team_id = v_reg.team_id;
    elsif v_team_event is not null then
      -- Same studio, an event row: it moves to the target event with its entry.
      update teams
         set race_event_id = p_to_event_id,
             name          = v_candidate,
             updated_at    = now()
       where id = v_reg.team_id;
    end if;
    -- Same studio, a legacy event-less row: unchanged, as before mig 870.
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

  -- The pre-race milestone events are keyed per registration (mig 085
  -- uq_contact_events_time_anchored on (source_type, source_id,
  -- event_type)), like the reminder sends: left in place, they would stop
  -- the timing cron emitting them for the new date.
  delete from contact_events
   where source_type = 'race_registration'
     and source_id = p_registration_id
     and event_type in ('race.starts_in_24h', 'race.starts_in_1h');

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

revoke execute on function public.move_race_registration(uuid, uuid, uuid, uuid, int, int, boolean, text, uuid, text, text)
  from public, anon, authenticated;

comment on function public.move_race_registration(uuid, uuid, uuid, uuid, int, int, boolean, text, uuid, text, text) is
  'EVENT-MOVE.1 (mig 708), TEAMNAMES.1 (mig 870): the writes of an entry move in one transaction; the team''s event row moves with it (renamed "Name (n)" if taken at the target). Rules are checked in src/lib/registration-move.js before calling. Service role only.';
