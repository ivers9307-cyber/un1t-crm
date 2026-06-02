-- RETIRE-SHIFTS-MIRROR.5c — repoint shift_swap_requests.{requester,target}_shift_id
-- from the legacy public.shifts(id) onto shift_assignments(id).
--
-- The table is empty (0 rows verified pre-migration) so there is NO data
-- translation to do. These two FK constraints were the last hard dependency
-- on public.shifts from the swap surface; dropping them unblocks the phase-6
-- public.shifts table drop. The covering FK indexes (mig 108) sit on the
-- columns, not the constraints, so they survive the repoint untouched.
--
-- Applied via Supabase MCP on 2026-06-02; this file mirrors it for the repo.

alter table public.shift_swap_requests
  drop constraint shift_swap_requests_requester_shift_id_fkey,
  add constraint shift_swap_requests_requester_shift_id_fkey
    foreign key (requester_shift_id) references public.shift_assignments(id) on delete cascade;

alter table public.shift_swap_requests
  drop constraint shift_swap_requests_target_shift_id_fkey,
  add constraint shift_swap_requests_target_shift_id_fkey
    foreign key (target_shift_id) references public.shift_assignments(id) on delete set null;

comment on column public.shift_swap_requests.requester_shift_id is
  'shift_assignments.id the requester wants to give away (RETIRE-SHIFTS-MIRROR.5c — repointed from shifts.id).';
comment on column public.shift_swap_requests.target_shift_id is
  'shift_assignments.id wanted in return; null = drop request (RETIRE-SHIFTS-MIRROR.5c — repointed from shifts.id).';
