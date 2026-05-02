-- 073 — Activities revamp phase 1: kind split.
--
-- Background: the activities table has been doing two unrelated
-- jobs that share a schema by accident:
--
--   Tasks:   manual ("schedule a follow-up call with Sarah"),
--            have a due_date and a `done` flag, surfaced on the
--            /activities page filtered by upcoming/overdue/done.
--   Events:  auto-logged ("SMS sent", "Booking confirmed",
--            "Roster published"), no due_date, no done state,
--            surfaced inline on the contact detail timeline.
--
-- The /activities page filters on `done` and `due_date` —
-- concepts that are meaningless for events. The contact-detail
-- timeline merges them together, which is useful for context
-- but only by accident. The schema doesn't enforce the split.
--
-- Phase 1 adds an explicit `kind` column so:
--   /activities filters kind='task' (becomes a real task list).
--   Contact detail can render tasks with a checkbox + events as
--   timeline dots, distinguishing the two visually.
--   Future writers (roster publish, deposit paid, etc.) write
--   kind='event' rows that don't pollute the task list.
--
-- Backfill rule: rows with a due_date are tasks (the operator
-- explicitly scheduled them); everything else is an event. Edge
-- cases (e.g. "I made a call yesterday and logged it without a
-- due_date") get classified as events, which matches their
-- nature anyway (something that happened, not something to do).
--
-- Reversibility: this is non-destructive. To roll back, drop the
-- column + the new writers introduced alongside this migration.

-- 1. Add the column with a sane default.
alter table public.activities
  add column if not exists kind text;

-- 2. Backfill.
update public.activities
   set kind = case when due_date is not null then 'task' else 'event' end
 where kind is null;

-- 3. Constraints.
alter table public.activities
  alter column kind set default 'event',
  alter column kind set not null;

alter table public.activities
  drop constraint if exists activities_kind_check;
alter table public.activities
  add constraint activities_kind_check
  check (kind in ('task', 'event'));

comment on column public.activities.kind is
  'Activities revamp phase 1 (mig 073). task = manual to-do (call/email/meeting/task with due_date + done). event = auto-logged interaction (SMS/email sent, booking confirmed, roster published). Drives /activities filter + contact-detail visual rendering.';

-- 4. Index — the /activities page query becomes
--    WHERE location_id = ? AND kind = 'task' AND done = ?
--    so a partial index on (location_id, kind, done) speeds it
--    up without bloating writes for events.
create index if not exists activities_location_kind_idx
  on public.activities (location_id, kind, due_date)
  where kind = 'task';
