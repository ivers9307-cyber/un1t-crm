-- 072 — Roster v2 phase 5: rosters table + draft/published state.
--
-- Per the locked spec (CLAUDE.md "Roster v2 — locked decisions"):
--   - draft: editing freely, no notification, no audit trail.
--   - published: live to staff, audit trail of who published when.
--   - Over-budget publishes require owner approval, recorded
--     on the roster row (over_budget_approval_by/at).
--
-- A roster row represents one publish event for a (location,
-- period) — usually a week. Blocks within the period get tagged
-- with roster_id at publish time so we can answer "which roster
-- does this block belong to?".
--
-- Re-publishes: a second publish for the same period creates a
-- new roster row and re-tags the blocks. The previous roster
-- stays in the history (FK ON DELETE SET NULL on shift_blocks
-- preserves the audit trail even if a stale roster is deleted).

-- ============================================================
-- 1. rosters
-- ============================================================
create table if not exists public.rosters (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,

  -- The window of dates this roster covers. Inclusive on both
  -- ends. Typically a Mon-Sun week, but the data model accepts
  -- any range — copy-month publishes a 30-ish-day range.
  period_start date not null,
  period_end date not null,

  -- Lifecycle.
  --   draft     — created when an over-budget publish was attempted
  --               by a non-owner; needs owner sign-off.
  --   published — live, blocks visible to staff. Most rosters go
  --               straight to published from the create call.
  status text not null default 'published'
    check (status in ('draft', 'published')),

  -- Publish event. Always populated when status = 'published'.
  published_by uuid references public.profiles(id),
  published_at timestamptz,

  -- Over-budget approval. Populated when the publish exceeded
  -- the location's monthly_contractor_budget_eur. The approver
  -- can be the publisher themselves (owner publishing over their
  -- own budget) or a different owner approving a manager's
  -- request.
  over_budget_approval_by uuid references public.profiles(id),
  over_budget_approval_at timestamptz,

  -- Snapshot of the budget math at publish time. Useful for
  -- "why did we approve €X over last month?" retros — the budget
  -- and projected-cost values may have drifted since.
  projected_contractor_eur numeric,
  budget_at_publish_eur numeric,

  -- Optional human-readable notes from the publisher (or the
  -- approval rationale from the owner).
  notes text,

  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rosters_period_check check (period_end >= period_start)
);

comment on table public.rosters is
  'Roster v2 phase 5 — one row per publish event for a (location, period). status=draft means the publish was over budget and is awaiting owner approval. published rosters are live to staff. Blocks are linked back via shift_blocks.roster_id.';

create index rosters_location_idx on public.rosters (location_id);
create index rosters_period_idx on public.rosters (location_id, period_start, period_end);
create index rosters_status_idx on public.rosters (status) where status = 'draft';

-- ============================================================
-- 2. shift_blocks.roster_id
-- ============================================================
alter table public.shift_blocks
  drop constraint if exists shift_blocks_roster_fk;

alter table public.shift_blocks
  add constraint shift_blocks_roster_fk
  foreign key (roster_id) references public.rosters(id)
  on delete set null;

-- (The roster_id column itself was already added in mig 067 as a
-- placeholder — typed uuid, nullable, no FK. Phase 5 turns it on.)

-- ============================================================
-- 3. updated_at trigger
-- ============================================================
drop trigger if exists set_rosters_updated_at on public.rosters;
create trigger set_rosters_updated_at
  before update on public.rosters
  for each row execute function update_updated_at();

-- ============================================================
-- 4. RLS
-- Read: master + anyone in the location.
-- Write: master + manager_at the location.
-- ============================================================
alter table public.rosters enable row level security;

drop policy if exists "rosters readable in-location" on public.rosters;
create policy "rosters readable in-location"
  on public.rosters for select to authenticated
  using (
    private.auth_is_master()
    or private.auth_is_in_location(location_id)
  );

drop policy if exists "rosters managers can write" on public.rosters;
create policy "rosters managers can write"
  on public.rosters for all to authenticated
  using (
    private.auth_is_master()
    or private.auth_is_manager_at(location_id)
  )
  with check (
    private.auth_is_master()
    or private.auth_is_manager_at(location_id)
  );

drop policy if exists "Service role full access" on public.rosters;
create policy "Service role full access" on public.rosters
  for all using (true) with check (true);
