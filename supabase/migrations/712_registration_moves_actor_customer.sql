-- 712 — EVENT-MOVE.6: a customer may move their own entry.
--
-- WHY. The person who booked an entry can now change its date themselves
-- from the link in their confirmation email (/event/entry/[token]). Every
-- move writes a registration_moves row naming who did it, and mig 708's
-- CHECK only knew staff, host and agent, so a self-service move would fail
-- the insert inside move_race_registration.
--
-- WHAT. Widen registration_moves.actor_type to include 'customer'. For a
-- customer move actor_id is the lead contact's id (contacts.id; the column
-- has no FK, as for the other actor types) and actor_name the lead's name.
-- The constraint keeps its mig 708 name (Postgres named the inline column
-- CHECK registration_moves_actor_type_check). Drop and re-add, guarded on the
-- catalog so the file re-applies cleanly. No data changes; every existing
-- row is staff, host or agent and passes the wider check. Safe to apply
-- before the code deploys.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.registration_moves'::regclass
      and conname = 'registration_moves_actor_type_check'
  ) then
    alter table public.registration_moves drop constraint registration_moves_actor_type_check;
  end if;
  alter table public.registration_moves
    add constraint registration_moves_actor_type_check
    check (actor_type in ('staff', 'host', 'agent', 'customer'));
end
$$;

comment on column public.registration_moves.actor_type is
  'EVENT-MOVE.1/.6 — who moved the entry: staff | host | agent | customer (mig 712: the lead contact, from their entry link; actor_id = contacts.id).';
