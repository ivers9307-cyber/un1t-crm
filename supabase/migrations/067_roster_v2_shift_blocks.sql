-- 067 — Roster v2 phase 1: shift templates as demand windows,
-- shift blocks as fulfilment instances, multi-coach assignments.
--
-- Background: the original schedule (mig 010) modelled a shift as
-- "one row per coach per template per day" — i.e. a template was a
-- thing a coach does. Roster v2 inverts that:
--
--   shift_template = a demand window the location needs covered
--                    (9:30–10:30 mon–fri, up to 15 coaches)
--   shift_block    = the instance of that demand on a specific date
--   shift_assignment = which coach(es) are filling that block
--
-- A block can exist with zero assignments — that's an unstaffed
-- demand window, which is a problem to surface (red flag in the
-- calendar), not a row to suppress. Customers will be in the studio
-- regardless.
--
-- Phase 1 scope: data model only. UI continues to render the
-- legacy shifts table for one more deploy; phase 2 cuts over.
--
-- The legacy `public.shifts` table is NOT dropped here — it's
-- referenced by `shift_swap_requests` and read by mobile + reports
-- code that hasn't been migrated yet. Marked deprecated; phase 5
-- cleanup drops it once everything reads from blocks/assignments.

-- ============================================================
-- 1. Extend shift_templates with multi-day + capacity
-- ============================================================
alter table public.shift_templates
  add column if not exists days_of_week text[] not null default '{}'::text[],
  add column if not exists max_coaches smallint not null default 15;

-- Validate the day-name set. Same canonical short names used in
-- the rest of the codebase (see schemas.js `days`).
alter table public.shift_templates
  drop constraint if exists shift_templates_days_of_week_check;
alter table public.shift_templates
  add constraint shift_templates_days_of_week_check
  check (
    days_of_week <@ array['mon','tue','wed','thu','fri','sat','sun']::text[]
  );

-- Capacity sanity. 15 is the default; no hard cap, but >50 is
-- almost certainly a typo.
alter table public.shift_templates
  drop constraint if exists shift_templates_max_coaches_check;
alter table public.shift_templates
  add constraint shift_templates_max_coaches_check
  check (max_coaches between 1 and 50);

comment on column public.shift_templates.days_of_week is
  'Weekdays this template applies to. Block-generation reads this when materialising future blocks. Empty array = inactive (no blocks generated).';
comment on column public.shift_templates.max_coaches is
  'Capacity per generated block. Snapshot onto the block at generation time so editing the template doesn''t mutate already-rostered weeks.';

-- ============================================================
-- 2. shift_blocks — one row per (template × date) instance
-- ============================================================
create table if not exists public.shift_blocks (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  template_id uuid not null references public.shift_templates(id) on delete restrict,

  -- The day this block falls on.
  block_date date not null,

  -- Snapshot of the template at generation time. Editing a
  -- template later (e.g. shifting 9:30 → 9:45) does NOT
  -- retroactively change blocks already on the calendar.
  start_time time not null,
  end_time time not null,
  max_coaches smallint not null default 15,

  -- Phase 5 hook — once rosters land, every block belongs to a
  -- roster row that drives the draft/published lifecycle.
  -- Nullable here so phase 1 backfill works before mig 070.
  roster_id uuid,

  notes text,

  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One block per template per day per location. (Two morning
  -- shifts on the same day require two templates — the demand
  -- model deliberately doesn't support "duplicate this slot".)
  unique (location_id, template_id, block_date),

  constraint shift_blocks_time_order check (end_time > start_time),
  constraint shift_blocks_max_coaches_check check (max_coaches between 1 and 50)
);

comment on table public.shift_blocks is
  'Demand window instance for a given date. May have zero coach assignments — those are flagged as unstaffed in the UI. Source of truth for the schedule from phase 2 onwards.';

create index shift_blocks_location_date_idx on public.shift_blocks (location_id, block_date);
create index shift_blocks_template_idx on public.shift_blocks (template_id);
create index shift_blocks_date_idx on public.shift_blocks (block_date);
create index shift_blocks_roster_idx on public.shift_blocks (roster_id) where roster_id is not null;

-- ============================================================
-- 3. shift_assignments — n:m coach × block
-- ============================================================
create table if not exists public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references public.shift_blocks(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,

  -- Per-assignment notes — overrides any block-level notes
  -- when displayed on the assignee's Today tab.
  notes text,

  -- Lifecycle. Mirrors the legacy shifts.status values for
  -- continuity. `cancelled` retains the row so we can show
  -- "Sarah was rostered but pulled out" in retros.
  status text not null default 'scheduled'
    check (status in ('scheduled', 'confirmed', 'completed', 'cancelled')),

  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A coach can't be on the same block twice.
  unique (block_id, profile_id)
);

comment on table public.shift_assignments is
  'Which coach(es) are filling a shift_block. Enforces no-double-assign per (block, profile). Capacity (block.max_coaches) is enforced at the application layer, not via constraint, so an over-capacity admin override is possible if explicitly requested.';

create index shift_assignments_block_idx on public.shift_assignments (block_id);
create index shift_assignments_profile_idx on public.shift_assignments (profile_id);
create index shift_assignments_status_idx on public.shift_assignments (status);

-- ============================================================
-- 4. updated_at triggers
-- ============================================================
drop trigger if exists set_shift_blocks_updated_at on public.shift_blocks;
create trigger set_shift_blocks_updated_at
  before update on public.shift_blocks
  for each row execute function update_updated_at();

drop trigger if exists set_shift_assignments_updated_at on public.shift_assignments;
create trigger set_shift_assignments_updated_at
  before update on public.shift_assignments
  for each row execute function update_updated_at();

-- ============================================================
-- 5. RLS
-- Mirrors the existing shift_templates / shifts policies but
-- expressed in terms of the per-location helper functions
-- (mig 051) so we don't re-hand-roll role checks.
-- ============================================================
alter table public.shift_blocks enable row level security;
alter table public.shift_assignments enable row level security;

-- Read access:
--   - Master: everything
--   - Anyone in the location: all blocks at that location (so a
--     coach can see "the studio is staffed Tue 9:30" even if it's
--     not their own shift).
--   - Coaches see their own assignments regardless of location
--     gate (covers cross-location floats).
drop policy if exists "shift_blocks readable in-location" on public.shift_blocks;
create policy "shift_blocks readable in-location"
  on public.shift_blocks for select to authenticated
  using (
    private.auth_is_master()
    or private.auth_is_in_location(location_id)
  );

drop policy if exists "shift_blocks managers can write" on public.shift_blocks;
create policy "shift_blocks managers can write"
  on public.shift_blocks for all to authenticated
  using (
    private.auth_is_master()
    or private.auth_is_manager_at(location_id)
  )
  with check (
    private.auth_is_master()
    or private.auth_is_manager_at(location_id)
  );

drop policy if exists "shift_assignments readable" on public.shift_assignments;
create policy "shift_assignments readable"
  on public.shift_assignments for select to authenticated
  using (
    private.auth_is_master()
    or profile_id = auth.uid()
    or exists (
      select 1 from public.shift_blocks b
      where b.id = shift_assignments.block_id
        and private.auth_is_in_location(b.location_id)
    )
  );

drop policy if exists "shift_assignments managers can write" on public.shift_assignments;
create policy "shift_assignments managers can write"
  on public.shift_assignments for all to authenticated
  using (
    private.auth_is_master()
    or exists (
      select 1 from public.shift_blocks b
      where b.id = shift_assignments.block_id
        and private.auth_is_manager_at(b.location_id)
    )
  )
  with check (
    private.auth_is_master()
    or exists (
      select 1 from public.shift_blocks b
      where b.id = shift_assignments.block_id
        and private.auth_is_manager_at(b.location_id)
    )
  );

-- Service-role escape hatch (matches existing migration pattern).
drop policy if exists "Service role full access" on public.shift_blocks;
create policy "Service role full access" on public.shift_blocks
  for all using (true) with check (true);

drop policy if exists "Service role full access" on public.shift_assignments;
create policy "Service role full access" on public.shift_assignments
  for all using (true) with check (true);

-- ============================================================
-- 6. Backfill from the legacy shifts table.
--
-- Each existing shift row (mig 010) becomes:
--   - one shift_block (template × date × location), if not
--     already present
--   - one shift_assignment linking the original coach
--
-- Idempotent: re-running this migration produces the same end
-- state. Uses the (location_id, template_id, block_date) unique
-- key on blocks and (block_id, profile_id) unique key on
-- assignments to dedupe.
-- ============================================================

-- Materialise blocks first.
insert into public.shift_blocks (
  location_id, template_id, block_date,
  start_time, end_time, max_coaches,
  notes, created_by, created_at
)
select
  s.location_id,
  s.shift_template_id,
  s.shift_date,
  coalesce(s.start_time_override, t.start_time),
  coalesce(s.end_time_override,   t.end_time),
  coalesce(t.max_coaches, 15),
  -- Concatenate per-shift notes if multiple coaches were on the
  -- same template+date in the legacy model. Cheap heuristic;
  -- operators can clean up later if they care.
  string_agg(distinct nullif(s.notes, ''), e'\n'),
  -- min() doesn't accept uuid — pick the earliest creator via
  -- array_agg ordered by created_at.
  (array_agg(s.created_by order by s.created_at))[1],
  min(s.created_at)
from public.shifts s
join public.shift_templates t on t.id = s.shift_template_id
group by s.location_id, s.shift_template_id, s.shift_date,
         coalesce(s.start_time_override, t.start_time),
         coalesce(s.end_time_override,   t.end_time),
         coalesce(t.max_coaches, 15)
on conflict (location_id, template_id, block_date) do nothing;

-- Then attach the original coach assignments.
insert into public.shift_assignments (
  block_id, profile_id, notes, status, assigned_by, assigned_at
)
select
  b.id,
  s.profile_id,
  -- Per-shift notes were redundantly concatenated to the block
  -- above. Keeping a per-assignment copy too — cheap, and means
  -- the Today-tab view can show the assignee their personal note
  -- without reading the block-level concat.
  s.notes,
  s.status,
  s.created_by,
  s.created_at
from public.shifts s
join public.shift_blocks b
  on b.location_id = s.location_id
 and b.template_id = s.shift_template_id
 and b.block_date  = s.shift_date
on conflict (block_id, profile_id) do nothing;

-- ============================================================
-- 7. Mark the legacy shifts table deprecated (do NOT drop).
-- shift_swap_requests still FK-references it; mobile + report
-- code still queries it. Phase 5 cleanup migration drops it
-- once all readers have been pointed at shift_blocks +
-- shift_assignments.
-- ============================================================
comment on table public.shifts is
  'DEPRECATED (mig 067 / Roster v2 phase 1). Source of truth has moved to public.shift_blocks + public.shift_assignments. Kept around because shift_swap_requests still FK-references it and mobile/reports code has not been migrated. To be dropped in the phase 5 cleanup migration once all readers have been retargeted.';

-- ============================================================
-- 8. Verification queries (commented — run manually after apply).
-- ============================================================
-- select
--   (select count(*) from public.shifts)            as legacy_shifts,
--   (select count(*) from public.shift_blocks)      as new_blocks,
--   (select count(*) from public.shift_assignments) as new_assignments;
-- expect: assignments == legacy_shifts; blocks <= legacy_shifts (consolidated).
--
-- select location_id, count(*) filter (where days_of_week = '{}'::text[]) as inactive_templates
-- from public.shift_templates group by location_id;
-- expect: every existing template starts with empty days_of_week.
-- Operators must edit each template once to set its applicable
-- days — phase 2 UI will surface a banner for this.
