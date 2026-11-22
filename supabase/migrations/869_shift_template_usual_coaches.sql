-- 869 — USUALCOACH.1: the coaches who usually work a shift template.
--
-- WHY. The nightly job (extend-roster-horizon) builds every week's shifts
-- from the templates with nobody on them, so each week starts empty and a
-- manager staffs it by hand or copies last week (COPYEMPTY.1). A template now
-- remembers its usual coaches: the nightly job puts them on the shifts it
-- creates, and "Fill usual coaches" on an empty week does the same for shifts
-- that already exist. Both skip a coach who has left, is on approved leave,
-- has said they cannot work, or is already on an overlapping shift
-- (src/lib/shift-usual-coaches.js).
--
-- WHAT. shift_templates.usual_coach_ids uuid[], in the order a manager picked
-- them (the fill takes them in that order up to the shift's maximum). Empty
-- by default. No foreign key: Postgres cannot reference from an array, and a
-- staff profile is never deleted (tombstoned, mig 622), so an id never
-- dangles; the save route checks every id is a current member of the
-- template's studio, and the fill re-checks at fill time.
--
-- grant: no decision needed. shift_templates is TABLE-granted SELECT to
-- authenticated (not column-granted), under shift_templates_select
-- (auth_is_in_location): staff at the studio already see its rota, so who
-- usually works a shift tells them nothing new. Writes stay on the service
-- role (the templates routes).
--
-- ORDER. Apply BEFORE the code deploys: the templates routes write this
-- column and the nightly job selects it by name.

alter table public.shift_templates
  add column if not exists usual_coach_ids uuid[] not null default '{}';

alter table public.shift_templates
  drop constraint if exists shift_templates_usual_coach_ids_size;
alter table public.shift_templates
  add constraint shift_templates_usual_coach_ids_size
  check (coalesce(array_length(usual_coach_ids, 1), 0) <= 50);

comment on column public.shift_templates.usual_coach_ids is
  'USUALCOACH.1 (mig 869): profile ids of the coaches who usually work this template, in fill order. The nightly horizon and "Fill usual coaches" assign them to empty unpublished shifts, skipping leave, cannot-work days and clashes.';
