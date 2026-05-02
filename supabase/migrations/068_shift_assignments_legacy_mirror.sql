-- 068 — Roster v2 phase 2: one-way mirror trigger from
-- shift_assignments → public.shifts (deprecated legacy table).
--
-- Why this exists: phase 2 cuts the web calendar over to read +
-- write the new shift_blocks / shift_assignments tables. But the
-- mobile app, the report generator, and the swap-requests system
-- still read public.shifts. Rather than migrate all of those in
-- one go (and risk a half-migrated state), we keep public.shifts
-- populated automatically from the new tables.
--
-- One-way only: web writes go to shift_assignments, the trigger
-- mirrors them to public.shifts. Direct writes to public.shifts
-- still work but new code paths shouldn't use them.
--
-- Phase 5 cleanup: drop this trigger + the public.shifts table
-- once mobile + reports have been migrated.

-- ============================================================
-- Helper: from a shift_assignment row, derive the legacy shift
-- record (location_id, profile_id, shift_template_id, shift_date,
-- start_time_override, end_time_override, status).
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
  if (tg_op = 'INSERT') then
    select * into v_block from public.shift_blocks where id = new.block_id;
    if not found then return new; end if;

    -- Pull the template so we can decide whether to populate
    -- start_time_override / end_time_override (only if the block
    -- was customised vs the template defaults).
    select * into v_template from public.shift_templates where id = v_block.template_id;

    insert into public.shifts (
      location_id,
      profile_id,
      shift_template_id,
      shift_date,
      start_time_override,
      end_time_override,
      role_label,
      notes,
      status,
      published,
      created_by,
      created_at,
      updated_at
    ) values (
      v_block.location_id,
      new.profile_id,
      v_block.template_id,
      v_block.block_date,
      case when v_template.start_time = v_block.start_time then null else v_block.start_time end,
      case when v_template.end_time   = v_block.end_time   then null else v_block.end_time end,
      v_template.role_label,
      coalesce(new.notes, v_block.notes),
      new.status,
      true,
      new.assigned_by,
      new.assigned_at,
      new.updated_at
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
    -- We need the block to know which legacy shift to remove.
    -- If the block has already been deleted (cascade case), the
    -- block-side trigger handles cleanup; just no-op here.
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

drop trigger if exists shift_assignments_mirror on public.shift_assignments;
create trigger shift_assignments_mirror
  after insert or update or delete on public.shift_assignments
  for each row execute function public.shift_assignments_mirror_to_shifts();

-- When a block is deleted (cascade or direct), all of its
-- legacy shifts go too. shift_assignments cascades via FK so
-- the per-row trigger above fires for each removed assignment;
-- but if a block is deleted without prior assignments (or with
-- a service-role bulk delete that bypasses the row trigger),
-- catch the orphan rows here.
create or replace function public.shift_blocks_cleanup_legacy_shifts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.shifts
   where location_id = old.location_id
     and shift_template_id = old.template_id
     and shift_date = old.block_date;
  return old;
end;
$$;

drop trigger if exists shift_blocks_cleanup on public.shift_blocks;
create trigger shift_blocks_cleanup
  after delete on public.shift_blocks
  for each row execute function public.shift_blocks_cleanup_legacy_shifts();

comment on function public.shift_assignments_mirror_to_shifts() is
  'Roster v2 phase 2 — mirrors shift_assignments writes into the legacy public.shifts table so mobile + reports keep working. To be removed in phase 5 cleanup.';

comment on function public.shift_blocks_cleanup_legacy_shifts() is
  'Roster v2 phase 2 — cleans up legacy public.shifts rows when a shift_block is deleted directly (e.g. service-role bulk delete that bypasses the per-assignment trigger). To be removed in phase 5 cleanup.';
