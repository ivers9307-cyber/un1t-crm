-- PIPELINES.1 — a board becomes a row owned by a location.
--
-- The pipeline had ONE hardcoded taxonomy and ONE hardcoded signal source.
-- pipeline_stages.board (mig 558) was a first step: it added a second board at
-- one location, but boards still had no owner, no mode and no identity, and
-- stage rows were seeded across every location by CROSS JOIN (migs 147/150/350)
-- — which is why CCF Autos, a car dealership, holds a "Trial Done" column.
--
-- `key` is identity, `module` is the code binding. The pair lets two locations
-- run a board under the same tab name with different rules.
--
-- `mode` is load-bearing, not a convenience flag. FUNNEL.1 removed drag-drop
-- from the board because the nightly classifier overwrites manual moves. A
-- manual board the classifier can SEE is a manual board whose every staff
-- action is reverted overnight. mode='manual' is the fence that makes manual
-- boards possible at all.
--
-- Nullable pipeline_id here on purpose: mig 597 sets NOT NULL after the code
-- that populates it has shipped. Same add-then-tighten shape as mig 458.

create table if not exists public.pipelines (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations(id) on delete cascade,
  key           text not null,
  name          text not null,
  module        text,
  mode          text not null default 'derived' check (mode in ('derived','manual')),
  is_primary    boolean not null default false,
  display_order int not null default 0,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint pipelines_location_key_unique unique (location_id, key),
  -- a derived board must name its module; a manual board must not have one
  constraint pipelines_module_matches_mode check (
    (mode = 'derived' and module is not null) or
    (mode = 'manual'  and module is null)
  )
);

comment on table public.pipelines is
  'PIPELINES.1 — one row per board per location. mode=manual boards are NEVER '
  'read or written by the classifier (see pipeline-reclassify.js); their deals '
  'move only by hand. Exactly one is_primary row per location owns '
  'contacts.pipeline_stage_slug.';

alter table public.pipelines enable row level security;

-- Browser reads only. Mobile lists a location's boards through the RLS-bound
-- client (mobile/lib/pipeline-api.js); every write path is service-role, which
-- bypasses RLS entirely.
--
-- NO write policies, on purpose: there is deliberately no board-builder UI
-- (operator decision, 2026-09-08 — boards are code), so the browser must never
-- be able to create, retitle or disable a board.
--
-- Per-command, never FOR ALL: a FOR ALL policy is the mig 483/485 defect class
-- that kills SELECT and stops realtime firing. Both helpers live in `private`
-- (mig 051); the `public.auth_is_in_location` of mig 014 was moved and no
-- longer exists. location_id is NOT NULL here, so pipeline_stages' null branch
-- is not needed.
drop policy if exists pipelines_select on public.pipelines;
create policy pipelines_select on public.pipelines
  for select to authenticated
  using (private.auth_is_admin_at(location_id) or private.auth_is_in_location(location_id));

-- Exactly one primary board per location. Partial, so a location with no
-- primary (a disabled-only location) is allowed.
create unique index if not exists pipelines_one_primary_per_location
  on public.pipelines (location_id) where is_primary;

alter table public.pipeline_stages add column if not exists pipeline_id uuid references public.pipelines(id);
alter table public.deals           add column if not exists pipeline_id uuid references public.pipelines(id);

-- Seed one pipeline per (location, board) that actually HAS stage rows, so the
-- backfill below can never orphan a stage. Locations with no stages (Pride
-- Training Club) get no row.
--
-- enabled: only the two live UN1T locations. CCF Autos / SourceIt / Test Studio
-- keep a DISABLED row purely so their 33 stray stage rows have a parent when
-- mig 597 sets pipeline_id NOT NULL — nothing renders a disabled pipeline.
insert into public.pipelines (location_id, key, name, module, mode, is_primary, display_order, enabled)
select
  ps.location_id,
  ps.board                                              as key,
  case ps.board when 'returning' then 'Returning' else 'Acquisition' end as name,
  case ps.board when 'returning' then 'returning' else 'acquisition' end as module,
  'derived'                                             as mode,
  (ps.board = 'acquisition')                            as is_primary,
  case ps.board when 'returning' then 1 else 0 end      as display_order,
  (l.id in (
    'a0000000-0000-0000-0000-000000000001',   -- UN1T Stillorgan
    '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'    -- UN1T Hatch Street
  ))                                                    as enabled
from (select distinct location_id, board from public.pipeline_stages) ps
join public.locations l on l.id = ps.location_id
on conflict (location_id, key) do nothing;

update public.pipeline_stages ps
   set pipeline_id = p.id
  from public.pipelines p
 where p.location_id = ps.location_id
   and p.key = ps.board
   and ps.pipeline_id is null;

-- The backfill sets pipeline_id and nothing else, so neither trigger below has
-- anything to react to — but both are FOR EACH ROW and would fire ~8,700 times.
-- sync_contacts_pipeline_stage_slug re-derives a slug that provably cannot
-- change (measured 2026-09-08: 0 drift) at the cost of a join and an update per
-- deal, which risks a statement timeout. deals_updated_at would reset
-- updated_at estate-wide, and mobile's board sorts on exactly that column
-- (listDealsByStage, `.order('updated_at', desc)`) — so leaving it armed would
-- make a migration that is meant to change NOTHING reshuffle every column on
-- every phone.
--
-- The other two triggers on deals need no handling: deal_stage_change_trigger
-- is guarded by `OLD.stage_id IS DISTINCT FROM NEW.stage_id` (it would
-- otherwise have written ~8,700 fake "Pipeline: moved to…" activity rows), and
-- trg_deal_stage_entered is BEFORE UPDATE **OF stage_id**, which this does not
-- touch.
--
-- Re-enabled immediately below, and asserted at the end. A raised exception
-- rolls the whole transaction back including these ALTERs, so a failure cannot
-- leave production with a disabled trigger.
alter table public.deals disable trigger sync_contacts_pipeline_stage_slug_trigger;
alter table public.deals disable trigger deals_updated_at;

update public.deals d
   set pipeline_id = ps.pipeline_id
  from public.pipeline_stages ps
 where ps.id = d.stage_id
   and d.pipeline_id is null;

alter table public.deals enable trigger deals_updated_at;
alter table public.deals enable trigger sync_contacts_pipeline_stage_slug_trigger;

-- Count, don't trust. Mig 559's lesson: a seed insert that silently drops a row
-- reports success and ships a board with a missing column.
do $$
declare
  orphan_stages int;
  orphan_deals  int;
  primaries     int;
begin
  select count(*) into orphan_stages from public.pipeline_stages where pipeline_id is null;
  select count(*) into orphan_deals  from public.deals d
    where d.pipeline_id is null and d.stage_id is not null;
  select count(*) into primaries from public.pipelines where is_primary;

  if orphan_stages > 0 then
    raise exception 'PIPELINES.1: % pipeline_stages rows have no pipeline_id', orphan_stages;
  end if;
  if orphan_deals > 0 then
    raise exception 'PIPELINES.1: % deals rows have no pipeline_id', orphan_deals;
  end if;
  if primaries < 1 then
    raise exception 'PIPELINES.1: no primary pipeline was seeded';
  end if;

  -- Never leave production with a trigger the backfill switched off.
  if exists (
    select 1 from pg_trigger
     where tgrelid = 'public.deals'::regclass
       and tgname in ('sync_contacts_pipeline_stage_slug_trigger', 'deals_updated_at')
       and tgenabled = 'D'
  ) then
    raise exception 'PIPELINES.1: a deals trigger was left disabled';
  end if;
end $$;
