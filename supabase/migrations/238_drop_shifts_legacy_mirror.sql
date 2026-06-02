-- RETIRE-SHIFTS-MIRROR.6 — drop the legacy public.shifts mirror entirely.
--
-- By this point NOTHING reads or writes public.shifts from application code:
--   - readers migrated: reports (.1), dashboards (.2), assistant (.3),
--     GET /api/schedule/shifts (.5d)
--   - writers migrated: assistant create_shift (.4), copy-week/month (.5b),
--     swaps (.5c), roster publish + approve notify (.6, this change)
--   - the dead create/update/delete shift routes were removed (.5)
--
-- ORDER OF DEPLOY MATTERS: the code change that stops writing public.shifts
-- (roster publish/approve notify re-sourced from blocks, /shifts/publish
-- endpoint deleted) MUST be deployed before this migration is applied, or a
-- publish on the old code would hit a dropped table. Applied via Supabase MCP
-- only after the code PR merged + deployed; this file mirrors it for the repo.
--
-- Inventory dropped:
--   - shift_assignments.shift_assignments_mirror trigger + fn
--     shift_assignments_mirror_to_shifts()  (forward mirror, mig 068/100)
--   - shift_blocks.shift_blocks_cleanup trigger + fn
--     shift_blocks_cleanup_legacy_shifts()  (deleted orphan shifts; mig 069)
--   - public.shifts table → CASCADE removes its shifts_legacy_mirror trigger
--     (reverse mirror) + set_shifts_updated_at
--   - fn shifts_mirror_to_assignments() (reverse mirror, mig 069)
--   - schedule_notifications.shift_id FK → shifts(id): the publish notify path
--     now writes the shift_assignment id there, so the constraint is removed
--     (column kept as a free reference id).
-- The shared update_updated_at() fn is left intact (used by many tables).

alter table public.schedule_notifications
  drop constraint if exists schedule_notifications_shift_id_fkey;

drop trigger if exists shift_assignments_mirror on public.shift_assignments;
drop trigger if exists shift_blocks_cleanup on public.shift_blocks;

drop function if exists public.shift_assignments_mirror_to_shifts() cascade;
drop function if exists public.shift_blocks_cleanup_legacy_shifts() cascade;

drop table if exists public.shifts cascade;

drop function if exists public.shifts_mirror_to_assignments() cascade;

comment on column public.schedule_notifications.shift_id is
  'shift_assignments.id of a representative shift in the notification (RETIRE-SHIFTS-MIRROR.6 — was a FK to the now-dropped public.shifts).';
