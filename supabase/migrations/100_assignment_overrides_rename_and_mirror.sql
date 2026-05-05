-- Mig 099 added actual_start_time / actual_end_time to shift_assignments,
-- but the existing convention in the codebase is start_time_override /
-- end_time_override (see public.shifts and src/lib/payroll.js, which
-- already reads those). Rename the columns to match — keeps grep
-- results aligned and lets payroll's existing override-aware
-- math work without changes.
--
-- Also wire the mirror trigger so a per-assignment override flows
-- through to public.shifts.start_time_override / end_time_override.
-- Today it only mirrors block-vs-template diffs; it should also
-- propagate assignment-level overrides on top.

alter table public.shift_assignments
  rename column actual_start_time to start_time_override;
alter table public.shift_assignments
  rename column actual_end_time   to end_time_override;

drop index if exists public.shift_assignments_partial_idx;
create index if not exists shift_assignments_partial_idx
  on public.shift_assignments (block_id)
  where start_time_override is not null or end_time_override is not null;

comment on column public.shift_assignments.start_time_override is
  'Per-assignment override; use when staff started later/earlier than block.start_time. NULL = inherit block. Mirrored to public.shifts.start_time_override by trigger.';
comment on column public.shift_assignments.end_time_override is
  'Per-assignment override; use when staff ended later/earlier than block.end_time. NULL = inherit block. Mirrored to public.shifts.end_time_override by trigger.';

-- Update the assignments→shifts mirror trigger so the override
-- hierarchy on the shifts row is:
--   assignment.start_time_override (if set)
--   else block.start_time (if it differs from the template's)
--   else NULL (use the template's)
-- Same shape for end_time. Same mirror, all three branches.

create or replace function public.shift_assignments_mirror_to_shifts()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_block public.shift_blocks%rowtype;
  v_template public.shift_templates%rowtype;
  v_start_override time;
  v_end_override   time;
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if (tg_op = 'INSERT' or tg_op = 'UPDATE') then
    select * into v_block from public.shift_blocks where id = new.block_id;
    if not found then return new; end if;

    select * into v_template from public.shift_templates where id = v_block.template_id;

    v_start_override :=
      coalesce(
        new.start_time_override,
        case when v_template.start_time = v_block.start_time then null else v_block.start_time end
      );
    v_end_override :=
      coalesce(
        new.end_time_override,
        case when v_template.end_time = v_block.end_time then null else v_block.end_time end
      );
  end if;

  if (tg_op = 'INSERT') then
    insert into public.shifts (
      location_id, profile_id, shift_template_id, shift_date,
      start_time_override, end_time_override, role_label, notes,
      status, published, created_by, created_at, updated_at
    ) values (
      v_block.location_id, new.profile_id, v_block.template_id, v_block.block_date,
      v_start_override, v_end_override,
      v_template.role_label,
      coalesce(new.notes, v_block.notes),
      new.status, true, new.assigned_by, new.assigned_at, new.updated_at
    )
    on conflict (location_id, profile_id, shift_template_id, shift_date) do update
      set status = excluded.status,
          notes = excluded.notes,
          start_time_override = excluded.start_time_override,
          end_time_override   = excluded.end_time_override,
          updated_at = excluded.updated_at;

    return new;

  elsif (tg_op = 'UPDATE') then
    update public.shifts
       set status              = new.status,
           notes               = coalesce(new.notes, v_block.notes),
           start_time_override = v_start_override,
           end_time_override   = v_end_override,
           updated_at          = new.updated_at
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
$function$;
