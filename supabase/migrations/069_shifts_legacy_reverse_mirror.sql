-- 069 — Roster v2 phase 2: reverse-direction mirror trigger.
--
-- Mig 068 added a one-way trigger: shift_assignments → public.shifts.
-- This migration adds the OTHER direction: writes to the legacy
-- public.shifts table propagate back into shift_blocks +
-- shift_assignments. That keeps the legacy POST /api/schedule/shifts,
-- /shifts/copy-week, /shifts/copy-month endpoints functional during
-- the phase 2 cutover without rewriting them.
--
-- Loop prevention: both this trigger and the mig 068 trigger guard
-- on pg_trigger_depth(). A direct INSERT INTO shifts fires this
-- trigger at depth 1, which inserts into shift_assignments and
-- fires the forward trigger at depth 2; the forward trigger sees
-- depth > 1 and exits without writing back. Same logic in reverse.
--
-- Phase 5 cleanup: drop both triggers + the legacy public.shifts
-- table once mobile + reports have been migrated.

-- ============================================================
-- Update mig 068 trigger to guard against re-entry.
-- ============================================================
create or replace function public.shift_assignments_mirror_to_shifts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_block public.shift_blocks%rowtype;
  v_template public.shift_templates%rowtype;
begin
  -- Re-entry guard: if we're inside a nested trigger call from
  -- the reverse mirror, no-op. Direct user writes hit this at
  -- depth 1; recursive calls would be depth 2+.
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if (tg_op = 'INSERT') then
    select * into v_block from public.shift_blocks where id = new.block_id;
    if not found then return new; end if;

    select * into v_template from public.shift_templates where id = v_block.template_id;

    insert into public.shifts (
      location_id, profile_id, shift_template_id, shift_date,
      start_time_override, end_time_override, role_label, notes,
      status, published, created_by, created_at, updated_at
    ) values (
      v_block.location_id, new.profile_id, v_block.template_id, v_block.block_date,
      case when v_template.start_time = v_block.start_time then null else v_block.start_time end,
      case when v_template.end_time   = v_block.end_time   then null else v_block.end_time end,
      v_template.role_label,
      coalesce(new.notes, v_block.notes),
      new.status, true, new.assigned_by, new.assigned_at, new.updated_at
    )
    on conflict (location_id, profile_id, shift_template_id, shift_date) do update
      set status = excluded.status,
          notes = excluded.notes,
          updated_at = excluded.updated_at;

    return new;

  elsif (tg_op = 'UPDATE') then
    select * into v_block from public.shift_blocks where id = new.block_id;
    if not found then return new; end if;

    update public.shifts
       set status = new.status,
           notes  = coalesce(new.notes, v_block.notes),
           updated_at = new.updated_at
     where location_id = v_block.location_id
       and profile_id  = new.profile_id
       and shift_template_id = v_block.template_id
       and shift_date  = v_block.block_date;

    return new;

  elsif (tg_op = 'DELETE') then
    select * into v_block from public.shift_blocks where id = old.block_id;
    if found then
      delete from public.shifts
       where location_id = v_block.location_id
         and profile_id  = old.profile_id
         and shift_template_id = v_block.template_id
         and shift_date  = v_block.block_date;
    end if;
    return old;
  end if;

  return null;
end;
$$;

-- ============================================================
-- Reverse direction — public.shifts → shift_blocks + shift_assignments.
--
-- A legacy INSERT into shifts:
--   1. Find or create the corresponding shift_block (one block
--      per (location, template, date)).
--   2. Insert the matching shift_assignment with the block_id.
-- A legacy DELETE removes only the assignment — the block stays
-- (it was originally generated from a template's days_of_week
-- and represents demand, not assignment). Empty future blocks
-- are exactly the unstaffed-flag UI state.
-- ============================================================
create or replace function public.shifts_mirror_to_assignments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_block_id uuid;
  v_template public.shift_templates%rowtype;
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if (tg_op = 'INSERT') then
    -- Snapshot from template to populate block defaults.
    select * into v_template from public.shift_templates where id = new.shift_template_id;
    if not found then return new; end if;

    -- Find or create the block.
    select id into v_block_id
      from public.shift_blocks
     where location_id = new.location_id
       and template_id = new.shift_template_id
       and block_date  = new.shift_date;

    if not found then
      insert into public.shift_blocks (
        location_id, template_id, block_date,
        start_time, end_time, max_coaches,
        notes, created_by
      ) values (
        new.location_id, new.shift_template_id, new.shift_date,
        coalesce(new.start_time_override, v_template.start_time),
        coalesce(new.end_time_override,   v_template.end_time),
        coalesce(v_template.max_coaches, 15),
        new.notes,
        new.created_by
      )
      returning id into v_block_id;
    end if;

    -- Insert the assignment, dedup on (block, profile).
    insert into public.shift_assignments (
      block_id, profile_id, notes, status, assigned_by, assigned_at, updated_at
    ) values (
      v_block_id, new.profile_id, new.notes, new.status,
      new.created_by, new.created_at, new.updated_at
    )
    on conflict (block_id, profile_id) do update
      set status = excluded.status,
          notes = excluded.notes,
          updated_at = excluded.updated_at;

    return new;

  elsif (tg_op = 'UPDATE') then
    -- Find the assignment via the (location, template, date, profile)
    -- composite, propagate status / notes only. Block-side fields
    -- (max_coaches, dates, times) aren't expected to change via the
    -- legacy table.
    update public.shift_assignments sa
       set status = new.status,
           notes = new.notes,
           updated_at = new.updated_at
      from public.shift_blocks b
     where sa.block_id = b.id
       and b.location_id = new.location_id
       and b.template_id = new.shift_template_id
       and b.block_date  = new.shift_date
       and sa.profile_id = new.profile_id;

    return new;

  elsif (tg_op = 'DELETE') then
    delete from public.shift_assignments sa
     using public.shift_blocks b
     where sa.block_id = b.id
       and b.location_id = old.location_id
       and b.template_id = old.shift_template_id
       and b.block_date  = old.shift_date
       and sa.profile_id = old.profile_id;

    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists shifts_legacy_mirror on public.shifts;
create trigger shifts_legacy_mirror
  after insert or update or delete on public.shifts
  for each row execute function public.shifts_mirror_to_assignments();

comment on function public.shifts_mirror_to_assignments() is
  'Roster v2 phase 2 — reverse mirror, public.shifts writes propagate to shift_blocks + shift_assignments. Guards against trigger loops via pg_trigger_depth(). To be removed in phase 5 cleanup.';
