-- Per-assignment time overrides for partial shifts.
--
-- The block holds the slot's intended times (Sat 9-5, max 4 coaches).
-- The assignment is who's filling the slot. Until now both shared the
-- block's times — Sarah is on the 9-5 block, payroll thinks she
-- worked 9-5. But real life: Sarah works 9-1, Bob covers 1-5; or
-- Sarah leaves at noon sick.
--
-- These columns let an assignment carry its own times when they
-- differ from the slot. NULL means "use block defaults" — the common
-- case stays cheap, no migration of historical rows needed.
--
-- partial_reason is free text (operators will write whatever they
-- want — "left early — sick", "covered for Mike at 13:00", etc.).
-- Capped at 200 chars at the API layer; nullable here.
--
-- Mig 100 renames these to start_time_override / end_time_override
-- to match the convention used on public.shifts and src/lib/payroll.js.
-- Both 099 and 100 have already been applied via Supabase MCP — these
-- files exist for source-control parity.

alter table public.shift_assignments
  add column if not exists actual_start_time time,
  add column if not exists actual_end_time   time,
  add column if not exists partial_reason    text;

create index if not exists shift_assignments_partial_idx
  on public.shift_assignments (block_id)
  where actual_start_time is not null or actual_end_time is not null;
